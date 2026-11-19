import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { browserLaunchOptions } from '../../../../scripts/browser/launch.utils.mjs';
import { startSiteDev } from '../../../../scripts/site/dev.mjs';
import { openFixture } from './openFixture.mjs';

test('isotropic support early exit preserves every consumed kernel value', { timeout: 60000 }, async () => {
  const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
  await site.demo.watcher.close();
  let browser;
  try {
    browser = await puppeteer.launch(browserLaunchOptions('test'));
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const fixture = path.resolve(import.meta.dirname, 'fixtures/surface.html');
    await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}`, errors);
    const result = await page.evaluate(() => window.testSaturatedSupport());
    assert(result.shortCircuited > 0, 'the fixture must actually skip saturated neighbors');
    assert(result.maxError < 1e-6, JSON.stringify(result));
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await site.close(); }
});
