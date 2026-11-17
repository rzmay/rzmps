import { browserLaunchOptions } from '../../../../scripts/browser/launch.utils.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../../scripts/site/dev.mjs';
import { openFixture } from './openFixture.mjs';

test('soft depth respects visible faces; opaque volume depth excludes transparent depth writers',
  { timeout: 90000 }, async () => {
    const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
    await site.demo.watcher.close();
    let browser;
    const results = [];
    try {
      browser = await puppeteer.launch(browserLaunchOptions('test', { headless: true, args: [...browserLaunchOptions('test').args, '--enable-unsafe-webgpu'] }));
      for (const backend of ['webgl', 'webgpu', 'webgpu&reversed=true']) {
        const page = await browser.newPage(), errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        const fixture = path.resolve(import.meta.dirname, 'fixtures/volume.html');
        const url = `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}?backend=${backend}`;
        await openFixture(page, url, errors);
        const result = await page.evaluate(async gpu => {
          const { runSceneDepthVisibility } = await import('./runSceneDepthVisibility.js');
          return runSceneDepthVisibility(gpu);
        }, backend.startsWith('webgpu'));
        results.push({ backend, ...result, errors });
        await fs.writeFile('/tmp/scene-depth-visibility.json', JSON.stringify(results, null, 2));
        assert.deepEqual(errors, []);
        assert(result.rows.every(row => row.restored));
        for (const row of result.rows) {
          const visible = ['front', 'back-only-visible', 'double-sided-back', 'transparent-writes-depth',
            'transparent-no-depth']
            .includes(row.name);
          assert(Math.abs(row.depth + (visible ? 2 : 30)) < 0.05, `${backend} ${JSON.stringify(row)}`);
          if (backend.startsWith('webgpu')) {
            const occluded = visible && !row.name.startsWith('transparent');
            assert(occluded ? row.full < 2 && row.reduced < 2
              : Math.abs(row.full - result.baseline) < 3 && Math.abs(row.reduced - result.baseline) < 3,
            `${backend} ${JSON.stringify(row)} baseline=${result.baseline}`);
          }
        }
        assert(Math.abs(result.alphaHole.depth + 30) < 0.05);
        assert(Math.abs(result.transparentHole + 30) < 0.05);
        assert(Math.abs(result.zeroOpacity + 30) < 0.05);
        assert(Math.abs(result.grouped.depth + 30) < 0.05 && result.grouped.restored);
        if (backend.startsWith('webgpu')) {
          assert(Math.abs(result.alphaHole.full - result.baseline) < 3);
          assert(Math.abs(result.layered.depth + 2) < 0.05);
          assert(result.layered.full > 0 && result.layered.full < result.baseline - 5);
          assert(Math.abs(result.layered.full - result.layered.reduced) < 3);
          assert(Math.abs(result.grouped.full - result.baseline) < 3);
          assert(Math.abs(result.grouped.reduced - result.baseline) < 3);
          assert(Math.abs(result.transmission.full - result.baseline) < 3);
          assert(Math.abs(result.transmission.reduced - result.baseline) < 3);
          assert(Math.abs(result.transmission.depth + 2) < 0.05);
          assert.deepEqual(result.fullPasses, { renders: 1, copies: 1 });
          assert.deepEqual(result.reducedPasses, { renders: 2, copies: 1 });
          assert(Math.abs(result.coldNoDepth - result.baseline) < 3);
        }
        await page.close();
      }
    } finally { await browser?.close(); await site.close(); }
  });
