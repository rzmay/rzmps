/* eslint-env browser */
// Actual demo lifecycle diagnostic. Raw samples stay outside public benchmark reports.
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../site/dev.mjs';

const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
const output = process.env.SMOKE_OUTPUT ?? '/tmp/smoke-lifecycle.json';
const history = { frames: [], timings: [], events: [] };
await fs.writeFile(`${output}l`, '');
await site.demo.watcher.close();
let browser;
try {
  browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'], protocolTimeout: 15000 });
  const page = await browser.newPage(), errors = [];
  await page.setViewport({ width: 1000, height: 750, deviceScaleFactor: Number(process.env.SMOKE_DPR ?? 1) });
  page.on('pageerror', error => errors.push(error.stack));
  const base = `http://127.0.0.1:${site.demo.httpServer.address().port}`;
  const query = new URLSearchParams({ preset: process.env.SMOKE_PRESET ?? 'Volumetric Smoke',
    renderer: 'webgpu', scene: process.env.SMOKE_SCENE ?? 'Checkerboard' });
  await page.goto(`${base}/?${query}`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.psgui-renderers', { timeout: 30000 });
  await page.evaluate(async ({ root, automaticQuality }) => {
    const { ParticleSystem } = await import(`/@fs${root}/packages/rzmps/build/index.mjs`);
    const guiURL = performance.getEntriesByType('resource')
      .find(entry => entry.name.includes('/gui/ParticleSystemGUI'))?.name;
    if (!guiURL) throw new Error('Demo GUI module was not loaded');
    const { ParticleSystemGUI } = await import(guiURL);
    const { passTimer } = await import(`/@fs${root}/scripts/benchmark/gpuPassTimer.js`);
    const { profileGasStages } = await import(`/@fs${root}/scripts/benchmark/gasStages.js`);
    const state = window.smokeLifecycle = { frames: [], timings: [], events: [], started: performance.now() };
    const heartbeat = () => { state.heartbeat = performance.now(); requestAnimationFrame(heartbeat); };
    requestAnimationFrame(heartbeat);
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) state.events.push({ event: 'long-task', t: entry.startTime - state.started,
        duration: entry.duration });
    });
    observer.observe({ type: 'longtask', buffered: false });
    const guiUpdate = ParticleSystemGUI.prototype.update;
    ParticleSystemGUI.prototype.update = function (...args) {
      state.gui = this; return guiUpdate.apply(this, args);
    };
    const update = ParticleSystem.prototype.update;
    ParticleSystem.prototype.update = function (...args) {
      const gas = this.modules.find(module => module.constructor.name === 'GasSimulation');
      if (!gas) return update.apply(this, args);
      state.system = this;
      const renderer = this.sceneRenderer, volume = this.renderers[0];
      if (!state.timer) {
        const device = renderer.backend.device;
        state.memory = { buffers: 0, textures: 0, peak: 0, created: 0, destroyed: 0 };
        device.addEventListener('uncapturederror', event => state.events.push({ event: 'gpu-error',
          t: performance.now() - state.started, type: event.error.constructor.name, message: event.error.message }));
        void device.lost.then(info => state.events.push({ event: 'device-lost',
          t: performance.now() - state.started, reason: info.reason, message: info.message }));
        // Delta accounting starts here: driver/canvas allocations and earlier resources are not GPU totals.
        for (const [method, category] of [['createBuffer', 'buffers'], ['createTexture', 'textures']]) {
          const create = device[method].bind(device);
          device[method] = descriptor => {
            const resource = create(descriptor);
            const size = descriptor.size;
            const dimensions = Array.isArray(size) ? size
              : [size.width, size.height ?? 1, size.depthOrArrayLayers ?? 1];
            const texelBytes = { rgba16float: 8, rgba32float: 16, r8unorm: 1, rg16float: 4,
              depth32float: 4, 'depth24plus-stencil8': 8 }[descriptor.format] ?? 4;
            const bytes = category === 'buffers' ? size : dimensions.reduce((a, b) => a * b, 1)
              * texelBytes * (descriptor.sampleCount ?? 1);
            state.memory[category] += bytes; state.memory.created++;
            state.memory.peak = Math.max(state.memory.peak, state.memory.buffers + state.memory.textures);
            let destroyed = false;
            const destroy = resource.destroy.bind(resource);
            resource.destroy = () => {
              if (!destroyed) { state.memory[category] -= bytes; state.memory.destroyed++; destroyed = true; }
              destroy();
            };
            return resource;
          };
        }
        state.cleanupCalls = 0;
        const cleanup = gas.cleanup;
        gas.cleanup = function (...args) { state.cleanupCalls++; return cleanup.apply(this, args); };
        if (!automaticQuality) gas.spatialGrid.autoVolumeQuality = false;
        state.timer = passTimer(renderer.backend.device, renderer.backend, () => state.stage ?? 'other');
        profileGasStages(renderer, gas, volume, state);
        const render = renderer.render;
        renderer.render = function (...args) {
          state.renderDepth = (state.renderDepth ?? 0) + 1;
          state.stage = args[0] === volume.dynamicTarget.scene ? 'volume/raymarch' : 'scene/render-reconstruction';
          let result;
          try { result = render.apply(this, args); } finally { state.renderDepth--; }
          if (!state.renderDepth) {
            state.lastRender = performance.now(); state.renderedFrames = (state.renderedFrames ?? 0) + 1;
          }
          if (state.measuring && !state.renderDepth) {
            state.measuring = false; state.pending = true;
            state.timer.finish().then(timing => state.timings.push({ t: performance.now() - state.started, ...timing }))
              .catch(error => state.events.push({ error: String(error) })).finally(() => { state.pending = false; });
          }
          return result;
        };
      }
      const start = performance.now();
      if (!state.pending && start - (state.lastTiming ?? 0) > 750) {
        state.lastTiming = start; state.timer.start(); state.measuring = true;
      }
      try { return update.apply(this, args); }
      finally {
        const grid = gas.volumeGrid;
        state.frames.push({ t: start - state.started, dt: this.deltaTime, elapsed: this._elapsedTime,
          interval: state.lastFrame ? start - state.lastFrame : 0, cpu: performance.now() - start,
          bounds: [...gas.bounds.min.toArray(), ...gas.bounds.max.toArray()],
          particles: [...gas.particleBounds.min.toArray(), ...gas.particleBounds.max.toArray()],
          occupied: [...gas.occupiedBounds.min.toArray(), ...gas.occupiedBounds.max.toArray()],
          cell: gas.cellSize, dimensions: gas.gridDimensions.toArray(), capacity: grid?.capacity,
          diagnostics: { ...gas.brickDiagnostics }, quality: gas.qualityPreparation?.stage,
          lighting: { ...volume.lightingGrid?.statistics }, scale: volume.dynamicTarget.resolutionScale,
          renderAverage: volume.dynamicTarget.average,
          targetCount: volume.dynamicTarget.targets.size,
          targetBytes: [...volume.dynamicTarget.targets.values()]
            .reduce((bytes, target) => bytes + target.width * target.height * 16, 0),
          pressure: { ...gas.pressureStats }, guards: { ...gas.guardDiagnostics,
            faces: gas.guardDiagnostics.faces.map(face => ({ ...face })) }, cleanupCalls: state.cleanupCalls,
          counters: { ...this.gpuConfigurationStats } });
        const row = state.frames.at(-1);
        Object.assign(row, { memory: { ...state.memory }, gasBytes: gas.allocatedBytes,
          qualityChanges: gas.domainChanges.quality, logicalChanges: gas.domainChanges.logical,
          heap: performance.memory?.usedJSHeapSize, renderMemory: { ...renderer.info.memory } });
        state.lastFrame = start;
      }
    };
  }, { root: path.resolve('.'), automaticQuality: process.env.SMOKE_AUTO_QUALITY !== '0' });
  await page.waitForFunction(() => window.smokeLifecycle?.frames.length > 5, { timeout: 30000 });
  const save = async () => {
    const result = await page.evaluate(() => {
      const state = window.smokeLifecycle;
      const { heartbeat, lastFrame, lastRender, renderedFrames, started } = state;
      return { frames: state.frames.splice(0), timings: state.timings.splice(0), events: state.events.splice(0),
        heartbeatAge: performance.now() - heartbeat,
        updateAge: performance.now() - lastFrame, renderAge: performance.now() - lastRender, renderedFrames,
        elapsed: performance.now() - started };
    });
    for (const key of ['frames', 'timings', 'events']) history[key].push(...result[key]);
    // Stream only the new samples; repeatedly serializing all browser history creates artificial stalls.
    await fs.appendFile(`${output}l`, `${JSON.stringify(result)}\n`);
    return { ...result, ...history };
  };
  let snapshot, nextSwitch = 15000, switchIndex = 0;
  const deadline = Date.now() + (Number(process.env.SMOKE_SECONDS ?? 12) + 15) * 1000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    snapshot = await save();
    if (process.env.SMOKE_STRESS === '1' && snapshot.elapsed >= nextSwitch && snapshot.updateAge < 3000) {
      const name = ['Moving Colliders', 'Color Lights', 'Checkerboard', 'Color Lights'][switchIndex++ % 4];
      await page.evaluate(async name => {
        const state = window.smokeLifecycle;
        state.events.push({ event: 'stress-switch', name, t: performance.now() - state.started });
        await state.gui.setScene(name);
        const camera = state.system.sceneCamera;
        camera.position.set(4 + Math.sin(state.started) * 2, 3, 5);
        camera.lookAt(0, 1.5, 0);
      }, name);
      nextSwitch += 15000;
    }
    if (snapshot.updateAge > 3000 || snapshot.renderAge > 3000
      || snapshot.events.some(event => event.event === 'device-lost')) break;
    if (snapshot.elapsed > Number(process.env.SMOKE_SECONDS ?? 12) * 1000) break;
  }
  for (const name of process.env.SMOKE_SWITCH === '0' || snapshot.updateAge > 3000
    ? [] : ['Color Lights', 'Checkerboard']) {
    await page.evaluate(async name => {
      const state = window.smokeLifecycle;
      const gas = state.system.modules.find(module => module.constructor.name === 'GasSimulation');
      const parent = state.system.parent, grid = gas.volumeGrid, cell = gas.cellSize;
      const bounds = [...gas.bounds.min.toArray(), ...gas.bounds.max.toArray()];
      state.events.push({ event: 'switch-start', name, t: performance.now() - state.started, bounds, cell });
      await state.gui.setScene(name);
      state.events.push({ event: 'switch-end', name, t: performance.now() - state.started,
        bounds: [...gas.bounds.min.toArray(), ...gas.bounds.max.toArray()], cell: gas.cellSize,
        sameParent: state.system.parent === parent, sameGrid: grid === gas.volumeGrid,
        cleanupCalls: state.cleanupCalls });
    }, name);
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 2500)));
    await save();
  }
  const result = await save();
  await fs.writeFile(output, JSON.stringify({ ...result, errors }, null, 2));
  for (let second = 0; second < Number(process.env.SMOKE_SECONDS ?? 12); second += 2) {
    const rows = result.frames.filter(row => row.t >= second * 1000 && row.t < (second + 2) * 1000);
    if (!rows.length) continue;
    const median = key => rows.map(row => row[key]).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
    console.log({ second, interval: median('interval'), cpu: median('cpu'), ...rows.at(-1),
      diagnostics: rows.at(-1).diagnostics, counters: undefined, particles: undefined, occupied: undefined });
  }
  console.log({ output, events: result.events, errors });
} finally {
  const timeout = setTimeout(() => browser?.process()?.kill('SIGTERM'), 5000);
  try { await browser?.close(); } finally { clearTimeout(timeout); await site.close(); }
}
