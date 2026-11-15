/* eslint-env browser */
// Opt-in diagnostics: exclusive compute/render timestamps on the same frozen demo state.
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../site/dev.mjs';
import { openFixture } from '../../tests/preview/fluids/openFixture.mjs';

const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
await site.demo.watcher.close();
let browser;
try {
  browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const fixture = path.resolve('scripts/tests/preview/fluids/fixtures/fluid.html');
  await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}`
    + '?example=volumetricSmoke&profile', errors, { timeout: 25000 });
  const measurements = await page.evaluate(async () => {
    const { renderer, scene, camera, system, flip: gas } = window.debugFluid;
    const { passTimer } = await import('/@fs' + location.pathname.split('/@fs')[1]
      .replace('/fluid.html', '/volume-quality.js'));
    const { default: colors } = await import('/@fs' + location.pathname.split('/@fs')[1]
      .replace('/scripts/tests/preview/fluids/fixtures/fluid.html', '/examples/scenes/colorLights.js'));
    await window.runFrames(200); system.pause();
    const volume = system.renderers.find(renderer => renderer.constructor.name === 'VolumeRenderer');
    const colored = colors(scene); colored.update(0);
    const timer = passTimer(renderer.backend.device, renderer.backend, () => 'lighting');
    const samples = [];
    const device = renderer.backend.device;
    const create = device.createComputePipelineAsync.bind(device);
    let pipelines = 0;
    device.createComputePipelineAsync = (...args) => { pipelines++; return create(...args); };
    for (const [name, lighting, moving, advancing] of [['off', false, false, false], ['static', true, false, false],
      ['directional', true, false, false], ['moving', true, true, false],
      ['active-off', false, true, true], ['active-lit', true, true, true]]) {
      volume.lightingGridOptions = lighting ? {} : undefined;
      volume.anisotropy = name === 'directional' ? 1e-8 : 0;
      if (advancing) system.start(false);
      system.updateRenderers(false);
      for (let i = 0; i < 3; i++) await renderer.renderAsync(scene, camera);
      await device.queue.onSubmittedWorkDone();
      for (let i = 0; i < 5; i++) {
        if (moving) colored.update(1 / 60);
        const start = performance.now(), before = pipelines;
        timer.start();
        if (advancing) system.advanceFrames(1, 1 / 60);
        await renderer.renderAsync(scene, camera);
        const cpuMs = performance.now() - start, timing = await timer.finish();
        samples.push({ name, cpuMs, pipelines: pipelines - before, ...timing });
      }
    }
    timer.dispose(); colored.cleanup(); device.createComputePipelineAsync = create;
    return { samples, grid: gas.gridDimensions.toArray(), cellSize: gas.cellSize,
      lighting: volume.lightingGrid.statistics };
  });
  const output = process.env.LIGHTING_OUTPUT ?? '/tmp/volume-lighting.json';
  await fs.writeFile(output, JSON.stringify({ measurements, errors }, null, 2));
  console.log(output);
  for (const name of ['off', 'static', 'directional', 'moving', 'active-off', 'active-lit']) {
    const rows = measurements.samples.filter(row => row.name === name);
    const median = key => rows.map(row => row[key]).sort((a, b) => a - b)[2];
    console.log(JSON.stringify({ name, cpuMs: median('cpuMs'), computeGPUms: median('computeGPUms'),
      renderGPUms: median('renderGPUms'), pipelines: rows.reduce((sum, row) => sum + row.pipelines, 0) }));
  }
} finally { await browser?.close(); await site.close(); }
