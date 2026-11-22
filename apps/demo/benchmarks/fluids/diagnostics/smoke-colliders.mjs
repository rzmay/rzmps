import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { browserLaunchOptions } from '../../../../../scripts/browser/launch.utils.mjs';
import { startSiteDev } from '../../../../../scripts/site/dev.mjs';
import { openFixture } from '../../../tests/fluids/openFixture.mjs';

// Internal controlled collider-path comparison; raw stage traces are excluded from normal benchmark reports.
const output = process.argv[2] ?? '/tmp/rzmps-smoke-colliders.json';
const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
await site.demo.watcher.close();
let browser;
try {
  browser = await puppeteer.launch(browserLaunchOptions('diagnostic'));
  const page = await browser.newPage(),
    errors = [];
  page.on('pageerror', error => errors.push(error.stack));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
    else if (message.text().startsWith('{"checkpoint"')) console.log(message.text());
  });
  await page.evaluateOnNewDocument(() => {
    let seed = 173;
    Math.random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  });
  const fixture = path.resolve('apps/demo/tests/fluids/fixtures/fluid.html');
  await openFixture(
    page,
    `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}` +
      '?example=volumetricSmoke&scene=lightProbes&profile=true',
    errors,
    { timeout: 30000 },
  );
  const result = await page.evaluate(async root => {
    const { passTimer } = await import(`/@fs${root}/benchmarks/lib/passTimer.js`);
    const { profileGasStages } = await import(`/@fs${root}/apps/demo/benchmarks/fluids/gasStages.utils.js`);
    const { summarizeFluidTimings, median } = await import(
      `/@fs${root}/apps/demo/benchmarks/fluids/fluidProfiling.utils.js`
    );
    const { default: legacyColliderSample } = await import(
      `/@fs${root}/apps/demo/benchmarks/fluids/diagnostics/legacyColliderSample.js`
    );
    const { renderer, scene, camera, system, flip: gas, sceneLifecycle } = window.debugFluid;
    const volume = system.renderers.find(item => item.constructor.name === 'VolumeRenderer');
    const start = performance.now();
    await system.prepare(renderer);
    const preparationMs = performance.now() - start;
    const state = { stage: 'other', gpuSamples: [], cpuSubmissionMs: [] };
    const restore = profileGasStages(renderer, gas, volume, state);
    const timer = passTimer(renderer.backend.device, renderer.backend, type =>
      type === 'render' ? 'scene/render' : state.stage,
    );
    const rows = [];
    const context = { system, deltaTimeNode: gas.boundaryDt };
    const step = async animated => {
      if (animated) sceneLifecycle.update(1 / 60);
      system.advanceFrames(1, 1 / 60);
      await renderer.renderAsync(scene, camera);
    };
    const workload = async () => ({
      cellWidth: gas.cellSize,
      bounds: gas.bounds.getSize(new window.debugFluid.THREE.Vector3()).toArray(),
      colliders: gas.collectedColliders.size,
      fields: gas.colliderAtlas.fields.length,
      capacity: gas.volumeGrid.capacity,
      grid: await gas.readGridDiagnostics(renderer),
      pressureTopologyVersion: gas.pressureTopologyVersion,
    });
    const measure = async (name, callback, samples = 5) => {
      state.gpuSamples = [];
      state.cpuSubmissionMs = [];
      state.cpuStages = {};
      for (let i = 0; i < 2; i++) await callback();
      await renderer.backend.device.queue.onSubmittedWorkDone();
      const wall = [];
      for (let i = 0; i < samples; i++) {
        timer.start();
        const start = performance.now();
        await callback();
        state.cpuSubmissionMs.push(performance.now() - start);
        state.gpuSamples.push(await timer.finish());
        wall.push(performance.now() - start);
      }
      const row = {
        name,
        ...summarizeFluidTimings(state),
        fencedWallMedianMs: median(wall),
        cpuStagesPerFrameMs: Object.fromEntries(
          Object.entries(state.cpuStages).map(([key, value]) => [key, value / (samples + 2)]),
        ),
        workload: await workload(),
        traces: state.gpuSamples,
      };
      rows.push(row);
      console.log(JSON.stringify({ checkpoint: name, gpuMs: row.gpuExecutionMedianMs, stages: row.gpuStageMedianMs }));
      return row;
    };
    try {
      for (let i = 0; i < 60; i++) await step(true);
      await measure('animated-room-1s', () => step(true));
      await measure('stationary-room-same-plume', () => step(false));
      await measure('render-only', () => renderer.renderAsync(scene, camera));
      for (let i = 0; i < 120; i++) await step(true);
      await measure('animated-room-3s', () => step(true));
      for (let i = 0; i < 120; i++) await step(true);
      await measure('animated-room-5s', () => step(true));
      const bake = () => {
        gas.solidStateKey = '';
        gas.computeSolidField(context, renderer);
      };
      await measure('atlas-full-boundary-frozen-state', bake);
      const optimizedBoundary = new Float32Array(await renderer.getArrayBufferAsync(gas.boundaryAttribute));
      const fields = [...gas.colliderAtlas.fields];
      const methods = fields.map(field => field.sample);
      const query = gas.colliderAtlas.createQuery;
      try {
        fields.forEach(field => {
          field.sample = function (...args) {
            return legacyColliderSample(this, ...args);
          };
        });
        gas.colliderAtlas.createQuery = () => undefined;
        gas.solidNode = gas.solidFreshNode = undefined;
        await measure('legacy-eager-full-boundary-same-state', bake);
        const legacyBoundary = new Float32Array(await renderer.getArrayBufferAsync(gas.boundaryAttribute));
        const metadata = new Uint32Array(await renderer.getArrayBufferAsync(gas.volumeGrid.pagesAttribute));
        const allocation = await gas.readGridDiagnostics(renderer);
        const start = gas.volumeGrid.directoryLayout.value.x + gas.volumeGrid.capacity * 2;
        const activeSlots = new Set(metadata.slice(start, start + allocation.activeBricks));
        let error = 0,
          allStorageError = 0;
        const differences = [];
        for (let i = 0; i < legacyBoundary.length; i++) {
          const delta = Math.abs(legacyBoundary[i] - optimizedBoundary[i]);
          allStorageError = Math.max(allStorageError, delta);
          const cell = Math.floor((i % (gas.cellCount * 4)) / 4);
          if (!activeSlots.has(Math.floor(cell / gas.volumeGrid.cellsPerBrick))) continue;
          error = Math.max(error, delta);
          if (delta > 1e-5 && differences.length < 12)
            differences.push({ index: i, compact: optimizedBoundary[i], legacy: legacyBoundary[i] });
        }
        rows[rows.length - 1].boundaryMaxError = error;
        rows[rows.length - 1].allStorageError = allStorageError;
        rows[rows.length - 1].boundaryDifferences = differences;
      } finally {
        fields.forEach((field, index) => {
          field.sample = methods[index];
        });
        gas.colliderAtlas.createQuery = query;
        gas.solidNode = gas.solidFreshNode = undefined;
      }

      // The full direct path exceeds baseline sampler limits. Compare identical eight-collider subsets.
      const colliders = gas.fluidColliders.slice(0, 8);
      const atlas = gas.colliderAtlas,
        update = atlas.update,
        sampler = atlas.sampler,
        texture = atlas.texture;
      Object.defineProperty(gas, 'fluidColliders', { configurable: true, get: () => colliders });
      try {
        atlas.update = () => {};
        gas.solidNode = gas.solidFreshNode = undefined;
        await measure('atlas-eight-collider-boundary', bake);
        atlas.sampler = () => undefined;
        atlas.texture = undefined;
        gas.solidNode = gas.solidFreshNode = undefined;
        await measure('direct-eight-collider-boundary-same-state', bake);
      } finally {
        delete gas.fluidColliders;
        atlas.update = update;
        atlas.sampler = sampler;
        atlas.texture = texture;
        gas.solidNode = gas.solidFreshNode = undefined;
        gas.solidCacheKey = '';
      }
      return { preparationMs, rows };
    } finally {
      timer.dispose();
      restore();
    }
  }, path.resolve('.'));
  await fs.writeFile(output, JSON.stringify({ ...result, errors }, null, 2));
  console.log(
    JSON.stringify(
      {
        output,
        errors,
        preparationMs: result.preparationMs,
        rows: result.rows.map(({ traces, workload, ...row }) => ({
          ...row,
          workload: {
            cellWidth: workload.cellWidth,
            bounds: workload.bounds,
            capacity: workload.capacity,
            colliders: workload.colliders,
            fields: workload.fields,
            activeBricks: workload.grid.activeBricks,
          },
        })),
      },
      null,
      2,
    ),
  );
  if (errors.length) throw new Error(errors.join('\n'));
  const reference = result.rows.find(row => row.boundaryMaxError !== undefined);
  if (reference?.boundaryMaxError > 1e-5) throw new Error(`Boundary mismatch: ${reference.boundaryMaxError}`);
} finally {
  await browser?.close();
  await site.close();
}
