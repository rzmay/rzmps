import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../site/dev.mjs';
import { openFixture } from './openFixture.mjs';

test('dense volume interiors retain opacity under jitter, masks, MSAA and grazing views',
  { timeout: 90000 }, async () => {
    const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
    await site.demo.watcher.close();
    let browser;
    try {
      browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
      const page = await browser.newPage(), errors = [], results = [];
      page.on('pageerror', error => errors.push(error.message));
      const fixture = path.resolve(import.meta.dirname, 'fixtures/volume.html');
      for (const msaa of [false, true]) {
        await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}`
          + `?backend=webgpu${msaa ? '&antialias' : ''}`, errors);
        results.push(...await page.evaluate(async msaa => {
          const { volume, red, renderer, scene, camera, system, THREE } = window.volumeFixture;
          const w = 481, h = 321, n = 48;
          renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
          red.density.resolution.set(n, n, n);
          red.density.bounds.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
          red.density.data = new Float32Array(n ** 3);
          Object.assign(volume, { tags: ['red'], generateChildren: false, dynamicResolution: false,
            opacity: 0.9, transmittanceThreshold: 0, densityMapping: 'Linear',
            densityNoiseStrength: 2, densityNoiseContrast: 3, densityNoiseOctaves: 1, densityNoiseSpeed: 0 });
          const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
          const context = canvas.getContext('2d');
          const capture = async () => {
            volume.update([], system, 0); await renderer.renderAsync(scene, camera);
            context.drawImage(renderer.domElement, 0, 0, w, h);
            return context.getImageData(0, 0, w, h).data;
          };
          const rows = [];
          for (const thin of [false, true]) {
            for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
              const r2 = ((x + 0.5) / n - 0.5) ** 2 + ((y + 0.5) / n - 0.5) ** 2
                + ((z + 0.5) / n - 0.5) ** 2;
              red.density.data[x + n * (y + n * z)] = thin
                ? Math.exp(-(((Math.sqrt(r2) - 0.28) / 0.012) ** 2)) : Math.exp(-r2 * 12);
            }
            red.density.version++;

            for (const angle of [0, 0.7, 1.57]) for (const frequency of [0, 1, 6]) {
              camera.position.set(4 * Math.sin(angle), 1.2, 4 * Math.cos(angle)); camera.lookAt(0, 0, 0);
              volume.densityNoiseStrength = frequency ? 2 : 0; volume.densityNoiseFrequency = frequency;
              Object.assign(volume, { steps: 512, samplesPerVoxel: 8, jitterStrength: 0, emptySpaceSkipping: false });
              const reference = await capture();
              Object.assign(volume, { steps: 256, samplesPerVoxel: 2, jitterStrength: 1, emptySpaceSkipping: true });
              const image = await capture();
              let holes = 0, isolated = 0, error = 0, compared = 0;
              for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
                const address = 4 * (x + w * y);
                if (reference[address] < 5) continue;
                compared++; error += (image[address] - reference[address]) ** 2;
                if (image[address] > 1) continue;
                holes++;
                let surrounding = 0;
                for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                  if ((dx || dy) && image[4 * (x + dx + w * (y + dy))] > 8) surrounding++;
                }
                if (surrounding >= 6) isolated++;
              }
              rows.push({ msaa, thin, angle, frequency, holes, isolated, compared, rmse: Math.sqrt(error / compared) });
            }
          }
          return rows;
        }, msaa));
      }
      await fs.writeFile('/tmp/volume-pixel-continuity.json', JSON.stringify({ results, errors }, null, 2));
      console.log(results);
      assert.deepEqual(errors, []);
      assert(results.every(row => row.frequency !== 0 || row.holes === 0),
        'unmasked dense interiors have no opacity holes');
      assert(results.every(row => row.frequency !== 1 || row.isolated === 0),
        'default masks have no isolated missing rays');
    } finally { await browser?.close(); await site.close(); }
  });
