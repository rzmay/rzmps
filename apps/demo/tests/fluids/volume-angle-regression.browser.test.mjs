import { browserLaunchOptions } from '../../../../scripts/browser/launch.utils.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../../scripts/site/dev.mjs';
import { openFixture } from './openFixture.mjs';

test('empty-space skipping preserves oblique and grazing rays through sparse field features',
  { timeout: 90000 }, async () => {
    const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
    await site.demo.watcher.close();
    let browser;
    try {
      browser = await puppeteer.launch(browserLaunchOptions('test', { headless: true, args: [...browserLaunchOptions('test').args, '--enable-unsafe-webgpu'] }));
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      const fixture = path.resolve(import.meta.dirname, 'fixtures/volume.html');
      const origin = `http://127.0.0.1:${site.demo.httpServer.address().port}`;
      await openFixture(page, `${origin}/@fs${fixture}?backend=webgpu`, errors);
      const result = await page.evaluate(async () => {
        const { volume, red, renderer, scene, camera, system, THREE } = window.volumeFixture;
        Object.assign(volume, { tags: ['red'], generateChildren: false, dynamicResolution: false,
          densityMapping: 'Linear', opacity: 0.8, steps: 160, samplesPerVoxel: 2,
          densityNoiseStrength: 0, transmittanceThreshold: 0 });
        const n = 48;
        red.density.resolution.set(n, n, n);
        red.density.bounds.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
        red.density.data = new Float32Array(n ** 3);
        for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
          const occupied = (x >= 19 && x <= 23 && y >= 8 && y <= 39 && z >= 16 && z <= 30)
            || (x >= 32 && x <= 34 && y >= 10 && y <= 20 && z >= 8 && z <= 36);
          if (occupied) red.density.data[x + n * (y + n * z)] = 0.8;
        }
        red.density.version++;
        const pixel = async () => {
          volume.update([], system, 0); await renderer.renderAsync(scene, camera);
          const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 320;
          const context = canvas.getContext('2d'); context.drawImage(renderer.domElement, 0, 0);
          return context.getImageData(0, 0, 480, 320).data;
        };
        const results = [];
        for (const angle of [0, 0.01, 0.4, 0.8, 1.2, 1.57, 2.1]) {
          camera.position.set(5 * Math.sin(angle), 1.4, 5 * Math.cos(angle)); camera.lookAt(0, 0, 0);
          for (const jitter of [0, 1]) {
            volume.jitterStrength = jitter; volume.emptySpaceSkipping = false;
            const reference = await pixel(); volume.emptySpaceSkipping = true;
            const skipped = await pixel(); let missing = 0, changed = 0, max = 0;
            for (let i = 0; i < skipped.length; i += 4) {
              const difference = Math.abs(skipped[i] - reference[i]);
              max = Math.max(max, difference); if (difference > 2) changed++;
              if (reference[i] > 30 && skipped[i] < 2) missing++;
            }
            results.push({ angle, jitter, missing, changed, max });
          }
        }
        return results;
      });
      await fs.writeFile('/tmp/volume-angle-regression.json', JSON.stringify(result, null, 2));
      assert.deepEqual(errors, []);
      assert(result.every(item => item.missing === 0), JSON.stringify(result));
      assert(result.every(item => item.jitter ? item.max <= 4 : item.max === 0), JSON.stringify(result));
    } finally { await browser?.close(); await site.close(); }
  });
