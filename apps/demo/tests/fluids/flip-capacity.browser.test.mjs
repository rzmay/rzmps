import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { browserLaunchOptions } from '../../../../scripts/browser/launch.utils.mjs';
import { startSiteDev } from '../../../../scripts/site/dev.mjs';
import { openFixture } from './openFixture.mjs';

test('FLIP 128→256 growth preserves programs, both velocity planes, pressure and zero tails',
  { timeout: 120000 }, async () => {
    const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
    await site.demo.watcher.close();
    const browser = await puppeteer.launch(browserLaunchOptions('test'));
    try {
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => {
        if (message.type() === 'error') { errors.push(message.text()); console.error(message.text()); }
      });
      const fixture = path.resolve(import.meta.dirname, 'fixtures/same-tier-resize.html');
      await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}`, errors);
      const result = await page.evaluate(() => window.measureFlipCapacity());
      console.log('FLIP compatible capacity:', JSON.stringify(result));
      assert.equal(result.capacity, 256);
      assert.equal(result.pipelines, 0);
      assert(result.samePrograms && result.exact && result.newTailZero);
      assert.deepEqual(result.beforePlane, [7, 8, 9, 0.25]);
      const sampling = await page.evaluate(() => window.measureFlipSampling());
      assert.equal(sampling.validation, null, 'FLIP multigrid must fit baseline WebGPU storage limits');
      assert.equal(sampling.multigrid.nonFiniteSamples, 0);
      assert(Number.isFinite(sampling.multigrid.pressureResidual));
      const coefficients = [[0.1, 0.2, 0.3], [0.2, 0.3, 0.4], [0.3, 0.4, 0.5]], offset = [1, 2, -1];
      for (const row of sampling.results) for (const [p, point] of row.points.entries()) {
        for (let axis = 0; axis < 3; axis++) {
          let sum = 0, weights = 0;
          const location = point.map((v, a) => v - (a === axis ? 0 : 0.5));
          const base = location.map(Math.floor), fraction = location.map((v, a) => v - base[a]);
          const wet = c => c.every((v, a) => v >= 0 && v < sampling.dimensions[a])
            && (!row.halfDry || c[0] < 4);
          for (let z = 0; z < 2; z++) for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
            const delta = [x, y, z], c = base.map((v, a) => Math.max(0,
              Math.min(sampling.dimensions[a] - (a === axis ? 0 : 1), v + delta[a])));
            const lower = c.map((v, a) => v - Number(a === axis));
            if (!wet(c) && !wet(lower)) continue;
            const w = delta.reduce((w, d, a) => w * (d ? fraction[a] : 1 - fraction[a]), 1);
            const velocity = offset[axis] + (row.linear ? c.reduce((s, v, a) =>
              s + (v + (a === axis ? 0 : 0.5)) * coefficients[axis][a], 0) : 0);
            sum += w * velocity; weights += w;
          }
          const expected = sum / Math.max(weights, 1e-6);
          assert(Math.abs(row.values[p * 8 + axis] - expected) < 2e-5);
          assert(Math.abs(row.values[p * 8 + 4 + axis] - expected * 0.25) < 2e-5);
        }
      }
      assert.deepEqual(errors, []);
    } finally { await browser.close(); await site.close(); }
  });
