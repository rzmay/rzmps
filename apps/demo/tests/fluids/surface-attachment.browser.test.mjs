import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { browserLaunchOptions } from '../../../../scripts/browser/launch.utils.mjs';
import { startSiteDev } from '../../../../scripts/site/dev.mjs';
import { openFixture } from './openFixture.mjs';

const close = (actual, expected, tolerance = 1e-4) => assert(Math.abs(actual - expected) < tolerance,
  `${actual} should be close to ${expected}`);

test('GPU attachment samples rigid transforms and the current sparse implicit liquid field',
  { timeout: 60000 }, async () => {
    const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
    await site.demo.watcher.close();
    let browser;
    try {
      browser = await puppeteer.launch(browserLaunchOptions('test'));
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      const fixture = path.resolve(import.meta.dirname, 'fixtures/surface-attachment.html');
      await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}`, errors);
      const mesh = await page.evaluate(() => window.testMeshAttachment());
      console.log('Rigid surface attachment:', JSON.stringify(mesh));
      close(mesh.stationary[1], 1.05); close(mesh.stationary[9], 0);
      close(mesh.translating[9], 2.5); assert(Math.abs(mesh.rotating[10]) > 1);
      assert.equal(mesh.stats.fullBuilds, 1, 'rigid motion only updates transforms');
      const liquid = await page.evaluate(() => window.testLiquidAttachment());
      console.log('Implicit liquid attachment:', JSON.stringify(liquid));
      close(liquid.initial[3], 0.05); close(liquid.initial[11], -0.05);
      close(liquid.initial[1], 1); close(liquid.initial[4], 2); close(liquid.initial[7], 1);
      close(liquid.initial[15], 0); close(liquid.initial[17], 0.11);
      assert(liquid.initial[20] > 1 && liquid.initial[20] < 2, 'drag preserves independent tangential motion');
      close(liquid.moved[3], -0.05); close(liquid.moved[17], 0.21);
      close(liquid.sparse[7], 0); assert.equal(liquid.sparse[19], 0, 'invalid support kills opted-in foam');
      close(liquid.missing[3], 0);
      assert.deepEqual(errors, []);
    } finally { await browser?.close(); await site.close(); }
  });
