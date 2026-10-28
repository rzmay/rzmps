import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../scripts/site/dev.mjs';

const output = process.argv[2] ?? '/tmp/rzmps-gas-stage-profile';
await fs.mkdir(output, { recursive: true });
const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
let browser;
try {
  browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
  const results = [];
  for (const [grid, width, height] of [['2,4', 800, 600], ['3,4', 800, 600],
    ['2,5', 800, 600], ['3,4', 1600, 900]]) {
    const page = await browser.newPage();
    page.setDefaultTimeout(180000);
    await page.setViewport({ width, height });
    const errors = [];
    let measuring = false;
    page.on('framenavigated', frame => {
      if (measuring && frame === page.mainFrame()) errors.push('Page reloaded during performance measurement');
    });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.evaluateOnNewDocument(() => {
      let seed = 173;
      Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    });
    const origin = `http://127.0.0.1:${site.demo.httpServer.address().port}`;
    const query = new URLSearchParams({ example: 'gasVolume', reviewGrid: grid, scene: 'gasFlow', profile: 'true' });
    await page.goto(`${origin}/@fs${path.resolve(import.meta.dirname, 'fixtures/fluid.html')}?${query}`);
    await page.waitForFunction(() => window.ready);
    measuring = true;
    const result = await page.evaluate(async ({ width, height }) => {
      const { system, renderer, flip: gas, scene, camera } = window.debugFluid;
      if (!renderer.backend.trackTimestamp) throw new Error('Native GPU timestamp queries unavailable');
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      const volume = system.renderers.find(item => item.constructor.name === 'VolumeRenderer');
      if (gas.volumeGrid.brickCount > 64) gas.maxActiveBricks = 64;
      const fence = () => renderer.backend.device.queue.onSubmittedWorkDone();
      let resolveRender;
      const resolve = type => type === 'render' && resolveRender
        ? resolveRender() : renderer.resolveTimestampsAsync(type);
      const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
      // Drain queries frequently: pressure iterations otherwise exhaust the finite query pool.
      for (let i = 0; i < 120; i++) {
        system.advanceFrames(1, 1 / 60);
        await resolve('compute');
      }
      await renderer.renderAsync(scene, camera);
      await resolve('render');
      const updateWall = [], updateSubmit = [], updateGPU = [];
      for (let i = 0; i < 12; i++) {
        await fence();
        const start = performance.now();
        system.advanceFrames(1, 1 / 60);
        updateSubmit.push(performance.now() - start);
        await fence();
        updateWall.push(performance.now() - start);
        updateGPU.push(await resolve('compute'));
      }

      const names = new Map();
      const label = (value, name) => {
        for (const node of Array.isArray(value) ? value : [value]) if (node) names.set(node, name);
      };
      for (const field of [gas.densityCurrent, gas.densityNext]) {
        label(gas.velocityNodes.get(field), 'velocity advection / buoyancy / turbulence');
        label(gas.sourceNodes.get(field), 'scalar advection / diffusion / dissipation');
        label(gas.scalarSourceNodes.get(field), 'density / temperature / color source gather');
        label(gas.outputNodes.get(field), 'simulation texture export');
      }
      label(gas.velocitySourceNode, 'velocity source gather');
      const restore = [];
      let stage = 'particle pipeline / other';
      const wrap = (owner, method, name) => {
        const original = owner[method];
        if (typeof original !== 'function') return;
        owner[method] = function (...args) {
          const previous = stage;
          stage = name;
          try { return original.apply(this, args); } finally { stage = previous; }
        };
        restore.push(() => { owner[method] = original; });
      };
      wrap(gas, 'computeGPU', 'simulation / other');
      wrap(gas, 'renderGPU', 'transient visual source gather / export');
      wrap(gas.spatialGrid, 'rebuild', 'particle spatial hash');
      wrap(gas.volumeGrid, 'rebuild', 'sparse brick activation / allocation');
      wrap(gas.volumeGrid, 'updateRenderSourceMask', 'transient source mask');
      wrap(gas, 'clearNewBricks', 'new brick clears');
      wrap(gas, 'remapFields', 'bounds remapping');
      wrap(gas, 'computeSolidField', 'grid collider sampling');
      wrap(gas.pressureProjection, 'initialize', 'staggered velocity initialization');
      wrap(gas, 'applyVorticity', 'vorticity');
      wrap(gas, 'solveProjection', 'pressure projection');
      wrap(gas, 'clearOutputTextures', 'dense texture clear');
      wrap(gas, 'reduceFieldMaxima', 'maxima reduction');
      const compute = renderer.compute;
      let dispatches = [];
      renderer.compute = function (nodes, ...args) {
        const result = compute.call(this, nodes, ...args);
        dispatches.push({ uid: renderer.backend.getTimestampUID(nodes), name: names.get(nodes) ?? stage });
        return result;
      };
      const samples = [];
      for (let i = 0; i < 12; i++) {
        dispatches = [];
        system.advanceFrames(1, 1 / 60);
        await resolve('compute');
        const times = renderer.backend.timestampQueryPool.compute.timestamps;
        const stages = {};
        for (const { uid, name } of dispatches) {
          const entry = stages[name] ??= { ms: 0, dispatches: 0 };
          if (!times.has(uid)) throw new Error(`Missing timestamp for ${name}: ${uid}`);
          entry.ms += times.get(uid);
          entry.dispatches++;
        }
        samples.push(stages);
      }
      renderer.compute = compute;
      restore.reverse().forEach(fn => fn());
      const stages = Object.fromEntries(Object.keys(samples[0]).map(name => [name, {
        gpuMs: median(samples.map(sample => sample[name]?.ms ?? 0)),
        dispatches: samples[0][name].dispatches,
      }]));
      const liveParticles = (await system.selectiveReadback(16000, ['position']))
        .filter(({ particle }) => particle.alive).length;
      // Framebuffer copies split/restart passes. Native GPU pass intervals can
      // overlap; measure their total span rather than double-counting their sum.
      const device = renderer.backend.device;
      const queries = device.createQuerySet({ type: 'timestamp', count: 128 });
      const resolveBuffer = device.createBuffer({ size: 1024,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
      const readBuffer = device.createBuffer({ size: 1024, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const createEncoder = device.createCommandEncoder.bind(device);
      let queryCount = 0;
      let renderIntervals = [];
      device.createCommandEncoder = (...args) => {
        const encoder = createEncoder(...args);
        const begin = encoder.beginRenderPass.bind(encoder);
        encoder.beginRenderPass = descriptor => {
          if (queryCount + 2 > 128) throw new Error('Diagnostic render query budget exceeded');
          const offset = queryCount;
          queryCount += 2;
          return begin({ ...descriptor, timestampWrites: { querySet: queries,
            beginningOfPassWriteIndex: offset, endOfPassWriteIndex: offset + 1 } });
        };
        return encoder;
      };
      resolveRender = async () => {
        const count = queryCount;
        if (!count) return 0;
        queryCount = 0;
        const encoder = createEncoder();
        encoder.resolveQuerySet(queries, 0, count, resolveBuffer, 0);
        encoder.copyBufferToBuffer(resolveBuffer, 0, readBuffer, 0, count * 8);
        device.queue.submit([encoder.finish()]);
        await readBuffer.mapAsync(GPUMapMode.READ, 0, count * 8);
        const data = new BigUint64Array(readBuffer.getMappedRange(0, count * 8));
        renderIntervals = [];
        const origin = data[0];
        let end = origin;
        for (let i = 0; i < count; i += 2) {
          if (data[i + 1] > end) end = data[i + 1];
          renderIntervals.push([Number(data[i] - origin) / 1e6, Number(data[i + 1] - origin) / 1e6]);
        }
        readBuffer.unmap();
        return Number(end - origin) / 1e6;
      };
      const rays = [];
      for (const steps of [80, 160]) for (const noiseStrength of [0, 0.7]) {
        const modes = [[false, false], [false, true], [true, false], [true, true]];
        for (const [adaptiveStepping, sceneDepthClipping] of modes) {
          Object.assign(volume, { steps, noiseStrength, adaptiveStepping, sceneDepthClipping,
            stepSizeMultiplier: 0.25 });
          volume._update([], system);
          for (let i = 0; i < 3; i++) {
            await renderer.renderAsync(scene, camera);
            await resolve('render');
          }
          const gpu = [], wall = [];
          for (let i = 0; i < 12; i++) {
            const start = performance.now();
            await renderer.renderAsync(scene, camera);
            await fence();
            wall.push(performance.now() - start);
            gpu.push(await resolve('render'));
          }
          rays.push({ steps, noiseStrength, adaptiveStepping, sceneDepthClipping,
            gpuMs: median(gpu), wallMs: median(wall), renderIntervals });
        }
      }
      volume.mesh.visible = false;
      const background = [];
      for (let i = 0; i < 12; i++) {
        await renderer.renderAsync(scene, camera);
        background.push(await resolve('render'));
      }
      volume.mesh.visible = true;
      await renderer.renderAsync(scene, camera);
      await resolve('render');
      device.createCommandEncoder = createEncoder;
      queries.destroy(); resolveBuffer.destroy(); readBuffer.destroy();
      const info = renderer.backend.device.adapterInfo;
      return { adapter: { vendor: info.vendor, architecture: info.architecture,
        device: info.device, description: info.description }, width, height, resolution: gas.resolution,
        pressureIterations: gas.pressureIterations, liveParticles, particleSlots: system._gpuBuffers.count,
        bricks: await gas.readGridDiagnostics(renderer), bounds: [gas.bounds.min.toArray(), gas.bounds.max.toArray()],
        update: { gpuMs: median(updateGPU), wallMs: median(updateWall), submitMs: median(updateSubmit) },
        stages, rays, backgroundGPU: median(background) };
    }, { width, height });
    measuring = false;
    if (errors.length) throw new Error(errors.join('\n'));
    results.push({ grid, ...result });
    await page.screenshot({ path: `${output}/gas-${grid.replace(',', '-')}-${width}.png` });
    await fs.writeFile(`${output}/metrics.json`, JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results.at(-1)));
    await page.close();
  }
} finally {
  await browser?.close();
  await site.close();
}
