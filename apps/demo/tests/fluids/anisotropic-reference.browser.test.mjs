import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { browserLaunchOptions } from '../../../../scripts/browser/launch.utils.mjs';
import { startSiteDev } from '../../../../scripts/site/dev.mjs';
import { openFixture } from './openFixture.mjs';

test('optimized anisotropic reconstruction retains full-neighbor fields, ellipsoids and surfaces',
  { timeout: 60000 }, async () => {
    const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
    await site.demo.watcher.close();
    let browser;
    try {
      browser = await puppeteer.launch(browserLaunchOptions('test'));
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const fixture = path.resolve(import.meta.dirname, 'fixtures/surface.html');
      await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}`, errors);
      const results = await page.evaluate(() => window.compareAnisotropicKernels());
      console.log(JSON.stringify(results));
      for (const row of results) {
        assert(row.fieldRelativeError < 1e-4, JSON.stringify(row));
        assert(row.shapeError < 1e-3, JSON.stringify(row));
        assert(row.positionError < 1e-3 && row.normalError < 0.02, JSON.stringify(row));
        assert.equal(row.triangles[0], row.triangles[1]);
        assert.equal(row.vertices[0], row.vertices[1]);
      }
      const queries = await page.evaluate(() => window.compareSurfaceQueryCellSizes());
      assert.deepEqual(queries.widths, [0.03125, 0.25]);
      assert(queries.relativeFieldError < 1e-5, JSON.stringify(queries));
      assert.equal(queries.triangles[0], queries.triangles[1]);
      assert(queries.clipping.every(value => value === 0));
      assert(queries.overflow.every(value => value === 0));
      console.log('Query-index invariance:', JSON.stringify(queries));
      await (await page.$('#anisotropic-quality')).screenshot({ path: '/tmp/liquid-anisotropic-quality.png' });
      assert.deepEqual(errors, []);
    } finally { await browser?.close(); await site.close(); }
  });
