import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { createServer } from 'vite';
import { browserLaunchOptions } from '../../../../../scripts/browser/launch.utils.mjs';
import { openFixture } from '../../../tests/fluids/openFixture.mjs';

// Internal release acceptance: ordinary RAF, moving room collider, no awaited per-frame fences/readbacks.
const output = process.argv[2] ?? '/tmp/fluid-release-smoke-room.json';
const server = await createServer({ root: path.resolve('apps/demo'),
  server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
let browser;
try {
  await server.listen();
  await server.watcher.close();
  browser = await puppeteer.launch(browserLaunchOptions('benchmark', { protocolTimeout: 180000 }));
  const page = await browser.newPage(), browserErrors = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text()); });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  await openFixture(page, `${origin}/tests/fluids/fixtures/fluid.html`
    + '?example=volumetricSmoke&scene=lightProbes&profile&measureStartup&prepareStartup', browserErrors);
  await page.waitForNetworkIdle({ idleTime: 1000 });
  await page.waitForFunction(() => window.ready);
  const startupBrowserErrors = browserErrors.splice(0);
  const result = await page.evaluate(async ({ root, seconds, detailedStages, timingStride }) => {
    const { passTimer } = await import(`/@fs${root}/benchmarks/lib/passTimer.js`);
    const { profileGasStages } = await import(`/@fs${root}/apps/demo/benchmarks/fluids/gasStages.utils.js`);
    const { trackSimulationTime } = await import(`/@fs${root}/apps/demo/benchmarks/fluids/fluidProfiling.utils.js`);
    const { frameDistribution } = await import(`/@fs${root}/apps/demo/benchmarks/fluids/liquidReliability.utils.js`);
    const { system, renderer, scene, camera, flip: gas, sceneLifecycle } = window.debugFluid;
    const volume = system.renderers.find(view => view.constructor.name === 'VolumeRenderer');
    const state = { stage: 'gas/other' }, device = renderer.backend.device;
    const restore = detailedStages ? profileGasStages(renderer, gas, volume, state) : () => {};
    const time = trackSimulationTime(system);
    const timer = passTimer(device, renderer.backend, type => type === 'render' ? 'scene/render' : state.stage,
      { slots: 8 });
    const frames = [], checkpoints = [], pending = new Set(), errors = [], longTasks = [];
    let lost, dropped = 0, nextCheckpoint = 0;
    device.addEventListener('uncapturederror', event => errors.push(event.error.message));
    void device.lost.then(info => { lost = { reason: info.reason, message: info.message }; });
    const observer = new PerformanceObserver(list => {
      longTasks.push(...list.getEntries().map(entry => ({ start: entry.startTime, duration: entry.duration })));
    });
    observer.observe({ type: 'longtask', buffered: false });
    const addPending = promise => {
      pending.add(promise);
      void promise.then(() => pending.delete(promise), error => {
        pending.delete(promise); errors.push(error.message);
      });
    };
    const started = performance.now();
    let previous = started;
    try {
      await new Promise((resolve, reject) => {
        const frame = timestamp => {
          try {
            const dt = (timestamp - previous) / 1000;
            previous = timestamp;
            const row = { time: (timestamp - started) / 1000, rafMs: dt * 1000 };
            const before = { ...time.time }, timed = frames.length % timingStride === 0 && timer.start();
            const cpu = performance.now();
            sceneLifecycle.update?.(dt);
            system.update();
            renderer.render(scene, camera);
            row.cpuMs = performance.now() - cpu;
            row.simulationTime = Object.fromEntries(Object.entries(time.time)
              .map(([key, value]) => [key, value - before[key]]));
            frames.push(row);
            if (timed) addPending(timer.finish().then(({ passes: _passes, ...gpu }) => { row.gpu = gpu; }));
            else dropped++;
            if (row.time >= nextCheckpoint) {
              nextCheckpoint += 10;
              const checkpoint = { time: row.time, cellWidth: gas.cellSize,
                bounds: [...gas.bounds.min.toArray(), ...gas.bounds.max.toArray()],
                colliders: gas.collectedColliders.size, particles: system.liveParticleCount };
              checkpoints.push(checkpoint);
              addPending(gas.readGridDiagnostics(renderer).then(grid => { checkpoint.grid = grid; }));
            }
            if (row.time < seconds) requestAnimationFrame(frame); else resolve();
          } catch (error) { reject(error); }
        };
        requestAnimationFrame(frame);
      });
      await Promise.all([...pending]);
      // Final field reads happen after acceptance timing; no full-field readback runs in the RAF loop.
      const fields = {};
      for (const name of ['densityCurrent', 'velocityCurrent', 'colorCurrent']) {
        const values = new Float32Array(await renderer.getArrayBufferAsync(gas[name].value));
        fields[name] = { nonFinite: values.reduce((n, value) => n + Number(!Number.isFinite(value)), 0),
          nonzero: values.reduce((n, value) => n + Number(value !== 0), 0) };
      }
      const windows = Array.from({ length: Math.ceil(seconds / 15) }, (_, index) => {
        const selected = frames.filter(row => row.time >= index * 15 && row.time < (index + 1) * 15);
        const stages = [...new Set(selected.flatMap(row => Object.keys(row.gpu?.allStageGPUms ?? {})))];
        return { from: index * 15, to: (index + 1) * 15, frames: selected.length,
          raf: frameDistribution(selected.map(row => row.rafMs)),
          cpu: frameDistribution(selected.map(row => row.cpuMs)),
          gpu: frameDistribution(selected.map(row => row.gpu?.totalGPUms)),
          stages: Object.fromEntries(stages.map(key => [key,
            frameDistribution(selected.map(row => row.gpu?.allStageGPUms[key] ?? 0))])) };
      });
      return { seconds, detailedStages, timingStride, frameCount: frames.length, windows, checkpoints, fields,
        errors, deviceLost: lost,
        simulationTime: time.time, longTasks, dropped, frames,
        convention: 'Normal real RAF; GPU interval unions, CPU submission and RAF intervals are separate. '
          + 'Stage distributions are not additive. Checkpoint diagnostics are asynchronous.' };
    } finally {
      observer.disconnect(); restore(); time.restore(); timer.dispose();
    }
  }, { root: process.cwd(), seconds: Number(process.env.SMOKE_SECONDS ?? 90),
    detailedStages: process.env.SMOKE_STAGES !== '0',
    timingStride: Number(process.env.SMOKE_TIMING_STRIDE ?? 1) });
  await fs.writeFile(output, JSON.stringify({ ...result, startupBrowserErrors, browserErrors }));
  const { frames: _frames, ...summary } = result;
  console.log(JSON.stringify({ ...summary, browserErrors }, null, 2));
  if (browserErrors.length || result.errors.length || result.deviceLost
    || Object.values(result.fields).some(field => field.nonFinite) || !result.fields.densityCurrent.nonzero) {
    throw new Error('Smoke room RAF acceptance failed; inspect the saved artifact');
  }
} finally {
  await browser?.close();
  await server.close();
}
