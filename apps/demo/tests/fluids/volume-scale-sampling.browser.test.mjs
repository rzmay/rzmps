import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../../scripts/site/dev.mjs';
import { browserLaunchOptions } from '../../../../scripts/browser/launch.utils.mjs';
import { openFixture } from './openFixture.mjs';

test(
  'volume scale changes preserve world-space mask coordinates and repeatable jitter',
  { timeout: 90000 },
  async () => {
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
      const fixture = path.resolve(import.meta.dirname, 'fixtures/volume.html');
      await openFixture(
        page,
        `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}?backend=webgpu`,
        errors,
      );
      const results = await page.evaluate(async () => {
        const { default: run } = await import('./runVolumeScaleSampling.js');
        return run();
      });
      for (const result of results) {
        await fs.writeFile(
          `/tmp/rzmps-volume-scale-${result.name}.png`,
          Buffer.from(result.image.split(',')[1], 'base64'),
        );
        delete result.image;
        assert.equal(result.repeatError, 0);
        assert(Math.abs(result.mask - results[0].mask) < 1e-5, JSON.stringify(result));
        assert(result.visiblePixels > 100);
      }
      await fs.writeFile('/tmp/rzmps-volume-scale-sampling.json', JSON.stringify(results, null, 2));
      console.log(JSON.stringify(results));
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await site.close();
    }
  },
);
