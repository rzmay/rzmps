import { browserLaunchOptions } from '../../../../scripts/browser/launch.utils.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../../scripts/site/dev.mjs';

test('normal full-suite gas cases expose steady and lifecycle context', { timeout: 180000 }, async () => {
  const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
  await site.demo.watcher.close();
  let browser;
  try {
    browser = await puppeteer.launch(browserLaunchOptions('test', { headless: true, args: [...browserLaunchOptions('test').args, '--enable-unsafe-webgpu'] }));
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${site.demo.httpServer.address().port}/benchmark.html`
      + '?benchmark=1&suite=gas&durationMs=200&warmupMs=100&simulationClock=fixed');
    await page.waitForFunction(() => window.__RZMPS_BENCHMARK_DONE__ || window.__RZMPS_BENCHMARK_ERROR__,
      { timeout: 160000 });
    const result = await page.evaluate(() => ({ rows: window.__RZMPS_BENCHMARK_RESULTS__,
      error: window.__RZMPS_BENCHMARK_ERROR__ }));
    await fs.writeFile('/tmp/gas-milestone-benchmarks.json', JSON.stringify({ result, errors }, null, 2));
    assert.deepEqual(errors, []);
    assert(!result.error, JSON.stringify(result.error));
    assert.equal(result.rows.length, 8);
    assert(result.rows.every(row => row.gas.workload.cellWidth > 0 && row.gpuProcessingActive));
    assert(result.rows.some(row => row.gas.category === 'lifecycle'));
  } finally { await browser?.close(); await site.close(); }
});
