import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../../scripts/site/dev.mjs';
import { browserLaunchOptions } from '../../../../scripts/browser/launch.utils.mjs';
import { openFixture } from '../fluids/openFixture.mjs';

test('projective batched decals render on both backends; GPU conditions compact before children/readback',
  { timeout: 120000 }, async () => {
    const site = await startSiteDev({ port: 0, host: '127.0.0.1' }); await site.demo.watcher.close();
    let browser;
    try {
      browser = await puppeteer.launch(browserLaunchOptions('test'));
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      const origin = `http://127.0.0.1:${site.demo.httpServer.address().port}`;
      const fixture = `/@fs${path.resolve(import.meta.dirname, 'fixtures/decals.html')}`;
      const images = [];
      for (const backend of ['webgl', 'webgpu']) {
        await openFixture(page, `${origin}${fixture}?backend=${backend}`, errors);
        const screenshot = await page.screenshot({ clip: { x: 8, y: 8, width: 256, height: 256 } });
        images.push(screenshot);
        await writeFile(`/tmp/rzmps-decal-${backend}.png`, screenshot);
        const splats = await page.evaluate(() => window.checkForwardSplat());
        const [forward, backward] = splats;
        assert.ok(forward.minX < 128 && forward.maxX > 128, 'footprint must straddle the impact');
        assert.ok(forward.maxX - 128 > 2 * (128 - forward.minX), 'forward splat must be asymmetric');
        assert.ok(128 - backward.minX > 2 * (backward.maxX - 128), 'reversing velocity reverses the warp');
        for (let i = 0; i < splats.length; i++) {
          await writeFile(`/tmp/rzmps-forward-splat-${backend}-${i}.png`,
            Buffer.from(splats[i].image.split(',')[1], 'base64'));
        }
        const bridges = await page.evaluate(() => window.checkForwardSplat(true));
        const [fitted, overlap] = bridges;
        assert(overlap.minX < fitted.minX - 5 && overlap.maxX > fitted.maxX + 5,
          `${backend}: overlap must extend both ends: ${JSON.stringify(bridges.map(({ minX, maxX }) => ({ minX, maxX })))}`);
        assert(Math.abs((fitted.minX + fitted.maxX) - (overlap.minX + overlap.maxX)) <= 2,
          'overlap preserves the midpoint between the two points');
        await writeFile(`/tmp/rzmps-point-bridge-${backend}.png`,
          Buffer.from(overlap.image.split(',')[1], 'base64'));
        const growth = await page.evaluate(() => window.checkDecalGrowth());
        assert.deepEqual(growth, { mismatch: 0, flicker: 0, count: 70 });
        const sampling = await page.evaluate(() => window.checkDecalSampling());
        assert.ok(sampling.mismatch < 100, JSON.stringify(sampling));
        assert.ok(sampling.transparent > 2000 && sampling.colored > 5000, JSON.stringify(sampling));
        if (backend === 'webgpu') {
          assert.ok(sampling.legacyMismatch > 1000, 'forced UVs must demonstrate the source-atlas regression');
          const composite = await page.evaluate(() => window.checkCompositeDecal());
          assert.equal(composite.length, 8, 'composed warped decals must stay inside eight vertex buffers');
          const selected = await page.evaluate(() => window.checkSelection());
          assert.deepEqual(selected, { cpu: 48, gpu: 48, invalid: false, groupedCPU: 3, groupedGPU: 3, empty: true });
          const readback = await page.evaluate(() => window.checkReadbackCondition());
          assert.equal(readback.count, 10, JSON.stringify(readback));
          assert.ok(readback.ids.every(id => Number(id.split(':')[1]) >= 10));
        }
      }
      // Pixel comparisons are intentionally tolerant of backend tone-mapping/edge raster differences.
      const { PNG } = await import('pngjs');
      const [a, b] = images.map(buffer => PNG.sync.read(buffer));
      let difference = 0, signal = 0;
      for (let i = 0; i < a.data.length; i += 4) {
        difference += Math.abs(a.data[i] - b.data[i]);
        if (a.data[i] < 100) signal++;
      }
      assert.ok(signal > 500, 'a dark warped footprint must actually be visible');
      assert.ok(difference / (a.width * a.height) < 10, 'backend projective footprints should agree');
      assert.deepEqual(errors, []);
    } finally { await browser?.close(); await site.close(); }
  });

