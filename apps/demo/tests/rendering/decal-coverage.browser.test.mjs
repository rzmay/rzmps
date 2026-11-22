import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../../scripts/site/dev.mjs';
import { browserLaunchOptions } from '../../../../scripts/browser/launch.utils.mjs';
import { openFixture } from '../fluids/openFixture.mjs';

test('decals union coverage with receiver-local detail on WebGL and WebGPU', { timeout: 120000 }, async () => {
  const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
  await site.demo.watcher.close();
  let browser;
  try {
    browser = await puppeteer.launch(browserLaunchOptions('test'));
    const page = await browser.newPage(),
      errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
    });
    const fixture = path.resolve(import.meta.dirname, 'fixtures/decal-coverage.html');
    for (const backend of ['webgl', 'webgpu']) {
      await openFixture(
        page,
        `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}?backend=${backend}`,
        errors,
      );
      const result = await page.evaluate(() => window.checkDecalCoverage());
      await writeFile(`/tmp/rzmps-decal-coverage-${backend}.png`, Buffer.from(result.image.split(',')[1], 'base64'));
      delete result.image;
      console.log(backend, JSON.stringify(result));
      assert.deepEqual(result.overlap, [0, 0]);
      assert.deepEqual(result.counts, [1, 1, 1]);
      assert.ok(result.adjacent < 100, JSON.stringify(result));
      assert.ok(result.warpDetail < 100, JSON.stringify(result));
      assert.ok(result.moved < 200, JSON.stringify(result));
      assert.equal(result.repeat, 0);
      assert.equal(result.stableGeometry, true);
      assert.equal(result.sourceLess, true);
      assert.equal(result.sharedReceivers, 1);
      assert.ok(result.differentReceivers < 200, JSON.stringify(result));
      assert.ok(result.preservedStencil > 50, 'unrelated stencil bit must survive');
      assert.equal(result.haloPixels, 0, 'binary footprint must not have a soft alpha halo');
      assert.ok(
        result.expiredCenter.every(value => value > 250),
        'expired marks must release coverage',
      );
      assert.ok(result.center[0] < 240, 'decals must actually shade');
      assert.ok(
        result.clearCenter.every(value => value > 250),
        'clear removes persistent coverage',
      );
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await site.close();
  }
});
