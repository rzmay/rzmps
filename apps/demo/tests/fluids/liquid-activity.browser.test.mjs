import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { browserLaunchOptions } from '../../../../scripts/browser/launch.utils.mjs';
import { startSiteDev } from '../../../../scripts/site/dev.mjs';
import { openFixture } from './openFixture.mjs';

test('surface strain and built-in aeration ignore uniform translation and preserve disturbed flow',
  { timeout: 60000 }, async () => {
    const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
    await site.demo.watcher.close();
    let browser;
    try {
      browser = await puppeteer.launch(browserLaunchOptions('test'));
      const page = await browser.newPage(), errors = [];
      await page.setViewport({ width: 1140, height: 260 });
      page.on('pageerror', error => errors.push(error.message));
      const fixture = path.resolve(import.meta.dirname, 'fixtures/liquid-activity.html');
      await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}`, errors);
      const rows = await page.evaluate(() => window.runActivityFixtures());
      const byName = Object.fromEntries(rows.map(row => [row.name, row]));
      for (const name of ['calm', 'translation', 'moving-container']) {
        const row = byName[name];
        assert(row.deformation < 1e-5); assert(Math.hypot(...row.curl) < 1e-5);
        assert.deepEqual(row.color, byName.calm.color);
        assert.equal(row.roughness, byName.calm.roughness);
      }
      assert(byName.translation.speed > 10);
      assert(Math.abs(byName.shear.deformation - Math.sqrt(8)) < 1e-4);
      assert(Math.abs(byName.shear.curl[2] + 4) < 1e-4);
      assert.deepEqual(byName.shear.color, byName['translated-shear'].color);
      assert(byName['rigid-rotation'].deformation < 1e-5);
      assert.equal(byName['rigid-rotation'].roughness, byName.calm.roughness);
      for (const name of ['shear', 'churning', 'breaking'])
        assert(byName[name].roughness > byName.calm.roughness + 0.1);
      assert(byName.breaking.roughness > 0.85);
      const foam = await page.evaluate(() => window.runFoamFixtures());
      assert(foam.every(row => row.valid === 1), JSON.stringify(foam));
      for (const row of foam) {
        const expected = row.name.includes('shear') ? 1 : 0;
        assert.equal(row.selected, expected, JSON.stringify(row));
        assert(Math.abs(row.deformation - (expected ? Math.sqrt(8) : 0)) < 1e-4, JSON.stringify(row));
      }
      const support = await page.evaluate(() => window.traceSupportActivity());
      assert(support.slice(0, 5).every(row => row.deformation < 1e-6), JSON.stringify(support));
      assert(support.at(-1).deformation > 16, 'well-supported physical shear must remain strong');
      const moving = await page.evaluate(() => window.traceMovingQuery());
      assert(moving.every(row => Math.abs(row.deformation - Math.sqrt(8)) < 1e-4));
      assert(moving.every(row => Math.abs(row.curl[2] + 4) < 1e-4));
      const bricks = await page.evaluate(() => window.traceBrickActivity());
      for (let i = 0; i < 65; i++) {
        assert(Math.abs(bricks.resident[i * 4 + 3] - Math.sqrt(8)) < 1e-4);
        assert(Math.abs(bricks.resident[i * 4 + 2] + 4) < 1e-4);
      }
      assert(bricks.missing.every((value, i) => Math.abs(value - bricks.empty[i]) < 1e-5),
        'nonresident pages must match ordinary empty cells');
      const counts = await page.evaluate(() => window.runPreparedCountFixture());
      assert(counts.gpuActive); assert(counts.live > 10);
      assert.equal(counts.snapshot['system/particleCount'], counts.live, JSON.stringify(counts));
      assert.equal(counts.snapshot['system/childrenCount'], counts.live * 3, JSON.stringify(counts));
      await page.screenshot({ path: '/tmp/liquid-surface-activity.png' });
      assert.deepEqual(errors, []);
    } finally { await browser?.close(); await site.close(); }
  });
