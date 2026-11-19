import path from 'node:path';
import fs from 'node:fs/promises';
import puppeteer from 'puppeteer';
import { browserLaunchOptions } from '../../../../../scripts/browser/launch.utils.mjs';
import { startSiteDev } from '../../../../../scripts/site/dev.mjs';
import { openFixture } from '../../../tests/fluids/openFixture.mjs';
const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
await site.demo.watcher.close();
let browser;
try {
  browser = await puppeteer.launch(browserLaunchOptions('diagnostic', { protocolTimeout: 600000 }));
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const output = process.argv[2] ?? '/tmp/liquid-teapot-milestone';
  await fs.mkdir(output, { recursive: true });
  await page.exposeFunction('recordCheckpoint', async event => {
    await fs.appendFile(path.join(output, 'trace.jsonl'), JSON.stringify(event) + '\n');
    console.log(JSON.stringify(event));
  });
  const fixture = path.resolve('apps/demo/tests/fluids/fixtures/fluid.html');
  await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}?demoLiquid`, errors);
  const result = await page.evaluate(async ({ stagesURL, timerURL, summaryURL, frameCount }) => {
    const { system, renderer, scene, camera, flip, sceneLifecycle } = window.debugFluid;

    const { profileLiquidStages } = await import(stagesURL);
    const { passTimer } = await import(timerURL);
    const { summarizeFluidTimings } = await import(summaryURL);
    const surface = system.renderers[0], state = { stage: 'liquid/other', gpuSamples: [],
      cpuSubmissionMs: [], detailedSurface: true };
    system.__liquidFixture = { flip, surface };
    const restore = profileLiquidStages(system, renderer, state), device = renderer.backend.device;
    const timer = passTimer(device, renderer.backend, type => type === 'render'
      ? 'liquid/surface rendering' : state.stage);
    const events = [], transitions = [], created = [];
    let activeCompute = [];
    const submit = renderer.compute;
    renderer.compute = function (nodes, ...args) {
      activeCompute = (Array.isArray(nodes) ? nodes : [nodes]).map(node => node.name);
      try { return submit.call(this, nodes, ...args); } finally { activeCompute = []; }
    };
    const transfer = flip.computeGPU;
    flip.computeGPU = function (...args) {
      const from = this.workGrid?.cellSize ?? this.cellSize;
      const ready = !!this.qualityPreparation?.ready, count = pipelines;
      const start = performance.now();
      const result = transfer.apply(this, args);
      if (this.cellSize !== from) transitions.push({ from, to: this.cellSize, prepared: ready,
        computePipelines: pipelines - count, programs: created.slice(count),
        cpuSubmissionMs: performance.now() - start });
      return result;
    };
    let pipelines = 0;
    const createPipeline = renderer.backend.createComputePipeline;
    renderer.backend.createComputePipeline = function (...args) {
      pipelines++; created.push({ names: activeCompute, stage: state.stage });
      return createPipeline.apply(this, args);
    };
    const model = scene.getObjectByName('Lidless Utah Teapot');
    for (let frame = 0; frame < frameCount; frame++) {
      const measured = frame % 120 === 0;
      if (measured) timer.start();
      const start = performance.now();
      sceneLifecycle.update?.(1 / 60); system.advanceFrames(1, 1 / 60);
      const cpu = performance.now() - start;
      await renderer.renderAsync(scene, camera);
      // Keep a finite GPU backlog; this diagnostic distinguishes expensive execution from flooding.
      await device.queue.onSubmittedWorkDone();
      if (measured) {
        state.cpuSubmissionMs.push(cpu); state.gpuSamples.push(await timer.finish());
        const samples = (await system.selectiveReadback(32000, ['position', 'velocity']))
          .filter(({ particle }) => particle.alive);
        const local = samples.map(({ particle }) => model.worldToLocal(system.localToWorld(particle.position.clone())));
        const event = { frame, seconds: (frame + 1) / 60, cpuSubmissionMs: cpu,
          fencedWallMs: performance.now() - start, timing: state.gpuSamples.at(-1),
          bounds: [...flip.bounds.min.toArray(), ...flip.bounds.max.toArray()], cellSize: flip.cellSize,
          particles: system.liveParticleCount, residentCapacity: flip.workGrid.capacity,
          pipelines, qualityPending: !!flip.qualityPreparation, capacity: flip.workPool?.status,
          spoutParticles: local.filter(p => p.x > 2.5 && p.x < 3 && Math.abs(p.z) < 0.4).length,
          outletParticles: local.filter(p => p.x > 3 && p.y > 2 && Math.abs(p.z) < 0.4).length,
          maxParticleSpeed: Math.max(0, ...samples.map(({ particle }) => particle.velocity.length())),
          surface: await surface.readSurfaceDiagnostics(),
          pressure: await flip.getPressureProjection().readDiagnostics(renderer, flip.velocityCurrent),
          memory: renderer.info.memory,
          secondary: [...system.subSystems.keys()].map(child => ({ name: child.name,
            count: child.liveParticleCount })) };
        events.push(event);
        await window.recordCheckpoint(event);
      }
    }
    timer.dispose(); renderer.compute = submit; restore();
    renderer.backend.createComputePipeline = createPipeline;
    flip.computeGPU = transfer;
    await renderer.renderAsync(scene, camera);
    return { live: summarizeFluidTimings(state), events, transitions,
      surface: await surface.readSurfaceDiagnostics(), foamEnabled:
        [...system.subSystems.keys()].some(child => child.name === 'Liquid Foam') };
  }, {
    frameCount: Number(process.env.LIQUID_FRAMES) || 2700,
    stagesURL: `/@fs${path.resolve('apps/demo/benchmarks/fluids/liquidStages.utils.js')}`,
    summaryURL: `/@fs${path.resolve('apps/demo/benchmarks/fluids/fluidProfiling.utils.js')}`,
    timerURL: `/@fs${path.resolve('benchmarks/lib/passTimer.js')}`,
  });
  await page.screenshot({ path: path.join(output, 'final.png') });
  await fs.writeFile(path.join(output, 'metrics.json'), JSON.stringify({ ...result, errors }, null, 2));
  console.log(JSON.stringify({ live: result.live, errors }));
} finally { await browser?.close(); await site.close(); }
