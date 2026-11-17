import { browserLaunchOptions } from '../../../../../scripts/browser/launch.utils.mjs';
/* eslint-env browser */
// Actual interactive demo timing, including DPR, shadows and normal wall-clock updates.
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../../../scripts/site/dev.mjs';
const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
const preset = process.env.LIGHTING_PRESET ?? 'Volumetric Smoke';
const sceneName = process.env.LIGHTING_SCENE ?? 'Color Lights';
await site.demo.watcher.close();
let browser;
try {
  browser = await puppeteer.launch(browserLaunchOptions('diagnostic', { headless: true, args: [...browserLaunchOptions('diagnostic').args, '--enable-unsafe-webgpu'] }));
  const page = await browser.newPage(), errors = [];
  await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 2 });
  page.on('pageerror', error => errors.push(error.stack));
  const origin = `http://127.0.0.1:${site.demo.httpServer.address().port}`;
  const query = new URLSearchParams({ preset, renderer: 'webgpu', scene: sceneName });
  await page.goto(`${origin}/?${query}`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.psgui-renderers', { timeout: 30000 });
  await page.evaluate(async libraryURL => {
    const { ParticleSystem } = await import(libraryURL);
    const update = ParticleSystem.prototype.update;
    window.lightingUI = { samples: [] };
    ParticleSystem.prototype.update = function (...args) {
      if (!this.modules.some(module => module.constructor.name === 'GasSimulation')) return update.apply(this, args);
      const start = performance.now(), previous = window.lightingUI.last;
      window.lightingUI.system = this;
      try { return update.apply(this, args); }
      finally {
        window.lightingUI.samples.push({ cpuMs: performance.now() - start,
          interval: previous ? start - previous : 0 });
        window.lightingUI.last = start;
      }
    };
  }, `/@fs${path.resolve('packages/rzmps/build/index.mjs')}`);
  await page.waitForFunction(() => window.lightingUI?.samples.length >= 30, { timeout: 30000 });
  const results = [];
  for (const lit of [true, false]) {
    await page.evaluate(lit => {
      const state = window.lightingUI;
      const volume = state.system.renderers.find(renderer => renderer.constructor.name === 'VolumeRenderer');
      volume.lightingGridOptions = lit ? {} : undefined;
      state.samples = [];
    }, lit);
    await page.waitForFunction(() => window.lightingUI.samples.length >= 30, { timeout: 30000 });
    results.push(await page.evaluate(lit => {
      const { system, samples } = window.lightingUI, gas = system.modules[0];
      return { lit, samples, cell: gas.cellSize, dimensions: gas.gridDimensions.toArray(),
        resident: gas.brickDiagnostics.resident, resolution: system.sceneRenderer.getPixelRatio(),
        quality: { auto: gas.spatialGrid.autoVolumeQuality, request: gas.spatialGrid.qualityRequest?.tier,
          age: performance.now() - gas.spatialGrid.qualityRequestedAt,
          preparation: gas.qualityPreparation && { key: gas.qualityPreparation.key, ready: gas.qualityPreparation.ready,
            stage: gas.qualityPreparation.stage, pressurePreparing: gas.qualityPreparation.pressure?.isPreparing,
            error: String(gas.qualityPreparation.error ?? ''), cap: gas.qualityPreparation.grid?.capacity },
          currentCapacity: gas.volumeGrid.capacity, options: gas.spatialGridOptions } };
    }, lit));
    await page.screenshot({ path: `/tmp/volume-lighting-ui-${lit}.png` });
  }
  const label = preset.replaceAll(' ', '-').toLowerCase();
  await fs.writeFile(`/tmp/volume-lighting-ui-${label}.json`, JSON.stringify({ results, errors }, null, 2));
  for (const result of results) {
    console.log({ ...result, samples: undefined,
      medianFrame: result.samples.map(row => row.interval).sort((a, b) => a - b)[15],
      medianUpdate: result.samples.map(row => row.cpuMs).sort((a, b) => a - b)[15] });
  }
  console.log(errors);
} finally { await browser?.close(); await site.close(); }
