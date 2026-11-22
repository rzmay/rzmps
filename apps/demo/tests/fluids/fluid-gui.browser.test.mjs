import { browserLaunchOptions } from '../../../../scripts/browser/launch.utils.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { createServer } from 'vite';

// This fixture tests configuration only; no WebGPU adapter or fluid preparation is necessary.
const site = await createServer({ root: path.resolve(import.meta.dirname, '../..'),
  server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
let browser;
try {
  await site.listen();
  browser = await puppeteer.launch(browserLaunchOptions('test'));
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${site.httpServer.address().port}/tests/fluids/fixtures/gui.html`);
  await page.waitForFunction(() => window.ready);
  const result = await page.evaluate(() => window.checkGUI());
  assert(result.unchanged, 'Opening the GUI must not mutate configuration or exported code');
  assert(result.emissions >= 9, 'Edits should regenerate code');
  for (const path of ['/Volume/Steps', '/Volume/Density Noise Strength', '/Volume/Adaptive Stepping',
    '/Volume/Lighting Grid Options/Levels', '/Surface/Material/Flow/Noise Speed/0',
    '/Light/Count', '/Light/Ratio', '/Light/Allocation/Shrink Delay', '/FLIP/Advect Particles']) {
    assert(result.paths.includes(path), `Missing API control ${path}`);
  }
  for (const path of result.paths) {
    assert(!/Ray Marching|Density Noise Mask|Flow Appearance|Renderer Children|Light Allocation/.test(path), path);
    assert(!/Runtime Data|Velocity Current|Volume Grid|Maxima|Use Spatial Grid|Advect Particles Enabled/.test(path), path);
  }
  assert.deepEqual(result.system, { substep: false, delta: 0.02, maxCatchup: 0.4,
    fps: 15, scale: 0.25, intensity: 0.8 });
  assert.deepEqual(result.gas, { resolution: 24, subdivisions: 3 });
  assert.deepEqual(result.flip, { advect: true, cfl: 1.5, iterations: 21, tolerance: 0.03,
    warmStart: false, adaptive: false, substeps: 3 });
  assert.deepEqual(result.volume, { levels: 3, count: 18, ratio: 0.75, groupingRadius: 3,
    children: 2, generateChildren: false, stretch: 0.4, emissive: 0.25 });
  assert.deepEqual(result.audio, { volume: 0.4, accepts: true });
  assert.deepEqual(result.decal, { scale: [2, 2], inheritMaterial: false, duplicateDistance: 0.2 });
  assert.equal(result.decalCount, 8);
  assert.deepEqual(result.surfaceNoise, [0.4, 0.2]);
  assert.deepEqual(result.light, { allocation: 4, brightness: [2, 3] });
  console.log('GUI hierarchy, non-mutating initialization, edits and executable code exports passed.');
} finally {
  await browser?.close();
  await site.close();
}
