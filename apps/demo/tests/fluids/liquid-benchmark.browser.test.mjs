import assert from 'node:assert/strict';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { browserLaunchOptions } from '../../../../scripts/browser/launch.utils.mjs';
import { startSiteDev } from '../../../../scripts/site/dev.mjs';

test('the demo benchmark page awaits liquid checkpoints and publishes the shared report format',
  { timeout: 90000 }, async () => {
    const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
    await site.demo.watcher.close();
    let browser;
    try {
      browser = await puppeteer.launch(browserLaunchOptions('test', { protocolTimeout: 60000 }));
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const parameters = new URLSearchParams({ suite: 'liquid', case: 'steady state 2k',
        durationMs: '250', warmupMs: '0', simulationClock: 'fixed' });
      await page.goto(`http://127.0.0.1:${site.demo.httpServer.address().port}/benchmark.html?${parameters}`);
      await page.waitForFunction(() => window.__RZMPS_BENCHMARK_PROGRESS__?.phase === 'complete'
        || window.__RZMPS_BENCHMARK_ERROR__, { timeout: 60000 });
      const result = await page.evaluate(() => ({ error: window.__RZMPS_BENCHMARK_ERROR__,
        rows: window.__RZMPS_BENCHMARK_RESULTS__ }));
      assert.equal(result.error, undefined, JSON.stringify(result.error));
      assert.equal(result.rows.length, 1);
      const row = result.rows[0];
      assert(row.frames >= 3);
      assert(row.liquid.quality.final.particles === 2000);
      assert.equal(row.liquid.quality.conservation.particleRetention, 1);
      assert.equal(row.gas, undefined);
      assert.equal(row.liquid.workload.surfaceExtraction, 'SurfaceNets');
      assert(row.liquid.lifecycle.preparedComputePipelines > 0);
      assert.equal(row.liquid.quality.final.surface.invalidSurfaceIndices, 0);
      assert(row.liquid.quality.final.surface.boundsCoverage > 0.9);
      if (row.liquid.timestampQuerySupported) {
        assert(row.liquid.samples > 0);
        assert(row.liquid.gpuStageMedianMs['liquid/P2G transfer'] > 0);
        assert(row.liquid.gpuStageMedianMs['liquid/surface rendering'] > 0);
      }
      assert.deepEqual(errors, []);
    } finally { await browser?.close(); await site.close(); }
  });
