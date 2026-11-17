import { browserLaunchOptions } from '../../../../scripts/browser/launch.utils.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../../scripts/site/dev.mjs';
import { openFixture } from './openFixture.mjs';

test('coarse angular transfer matches the prior reconstruction and records GPU cost', { timeout: 90000 }, async () => {
  const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
  await site.demo.watcher.close();
  let browser;
  try {
    browser = await puppeteer.launch(browserLaunchOptions('test', { headless: true, args: [...browserLaunchOptions('test').args, '--enable-unsafe-webgpu'] }));
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const fixture = path.resolve(import.meta.dirname, 'fixtures/lighting-grid.html');
    await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}`, errors);
    const result = await page.evaluate(async root => {
      const { ReferenceLightingGrid: Before } = await import(
        `/@fs${root}/apps/demo/tests/fluids/fixtures/referenceLightingGrid.js`);
      const { LightingGrid: After } = await import(`/@fs${root}/packages/rzmps/build/index.mjs`);
      const { passTimer } = await import(`/@fs${root}/benchmarks/lib/passTimer.js`);
      const { renderer, scene, bounds, position, sample, clearLights, THREE, float } = window.lightingFixture;
      const options = { directions: 12, cellSize: 0.25, levels: 3, samplesPerInterval: 8, maxDistance: 16 };
      const grids = [new Before(options), new After(options)];
      bounds.min.setScalar(-4); bounds.max.setScalar(4);
      clearLights();
      const light = new THREE.PointLight('white', 20, 0); scene.add(light);
      const timer = passTimer(renderer.backend.device, renderer.backend, () => 'lighting');
      const timings = [[], []], pairs = [];
      for (let step = 0; step < 18; step++) {
        light.position.set(Math.cos(step * 0.15) * 3, 2, Math.sin(step * 0.15) * 3);
        const values = [];
        for (let index = 0; index < grids.length; index++) {
          const grid = grids[index];
          if (step > 2) timer.start();
          grid.update(renderer, scene, bounds, { owner: light, version: step, extinctionGPU: () => float(0.08),
            shaderKey: 'constant' });
          if (step > 2) timings[index].push((await timer.finish()).computeGPUms);
          position.value.set(Math.sin(step) * 1.3, 0.2, Math.cos(step) * 1.1);
          values.push(await sample(grid, true));
        }
        pairs.push(values);
      }
      timer.dispose(); grids.forEach(grid => grid.dispose());
      return { timings, pairs };
    }, path.resolve('.'));
    await fs.writeFile('/tmp/gas-lighting-transfer.json', JSON.stringify({ result, errors }, null, 2));
    assert.deepEqual(errors, []);
    for (const [before, after] of result.pairs)
      before.forEach((value, i) => assert(Math.abs(value - after[i]) <= Math.max(0.005, Math.abs(value) * 0.01)));
  } finally { await browser?.close(); await site.close(); }
});
