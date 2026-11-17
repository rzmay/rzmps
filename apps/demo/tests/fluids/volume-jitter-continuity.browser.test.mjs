import { browserLaunchOptions } from '../../../../scripts/browser/launch.utils.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../../scripts/site/dev.mjs';
import { openFixture } from './openFixture.mjs';

test('full-strength volume jitter suppresses spatial blocks without altering trilinear reconstruction',
  { timeout: 60000 }, async () => {
    const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
    await site.demo.watcher.close();
    let browser;
    try {
      browser = await puppeteer.launch(browserLaunchOptions('test', { headless: true, args: [...browserLaunchOptions('test').args, '--enable-unsafe-webgpu'] }));
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const fixture = path.resolve(import.meta.dirname, 'fixtures/volume.html');
      const url = `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}?backend=webgpu`;
      await openFixture(page, url, errors);
      const result = await page.evaluate(async () => {
        const { probeVolumeInterpolation, legacyVolumeJitter } = await import('./measureVolumeSampling.js');
        const { volume, renderer, red, system, scene, camera, THREE } = window.volumeFixture;
        const probes = await probeVolumeInterpolation(volume, renderer);
        const n = 24, w = 480, h = 320;
        red.density.resolution.setScalar(n);
        red.density.bounds.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
        red.density.data = Float32Array.from({ length: n ** 3 }, (_, i) => {
          const x = (i % n + 0.5) / n - 0.5, y = (Math.floor(i / n) % n + 0.5) / n - 0.5;
          const z = (Math.floor(i / (n * n)) + 0.5) / n - 0.5;
          return Math.exp(-(x * x + y * y + z * z) * 16);
        });
        const source = new Float32Array(red.density.data);
        red.density.version++;
        Object.assign(volume, { tags: ['red'], generateChildren: false, dynamicResolution: false,
          downsample: 1, opacity: 0.9, threshold: 0.2, range: 0.025, jitterStrength: 1,
          densityNoiseStrength: 0, transmittanceThreshold: 0, interpolation: 'Linear' });
        const original = volume.createRayJitter.bind(volume);
        const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
        const context = canvas.getContext('2d'), rows = [];
        const capture = async (mode, reference = false) => {
          volume.steps = reference ? 512 : 128; volume.samplesPerVoxel = reference ? 12 : 1;
          volume.createRayJitter = mode === 'blue' ? original
            : () => (point, index) => legacyVolumeJitter(point, index, volume.gpuJitterSeed);
          volume.update([], system, 0); volume.updateMaterialTexture(); volume.update([], system, 0);
          await renderer.renderAsync(scene, camera);
          context.drawImage(renderer.domElement, 0, 0);
          return context.getImageData(0, 0, w, h).data;
        };
        for (const downsample of [1, 2]) for (const angle of [0, 0.7, 1.57]) {
          volume.downsample = downsample;
          camera.position.set(4 * Math.sin(angle), 1.2, 4 * Math.cos(angle)); camera.lookAt(0, 0, 0);
          const reference = await capture('blue', true), before = await capture('world'), after = await capture('blue');
          let oldError = 0, newError = 0, count = 0;
          for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
            if (reference[4 * (x + w * y)] < 8) continue;
            let old = 0, current = 0;
            for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
              const p = 4 * (x + dx + w * (y + dy));
              old += before[p] - reference[p]; current += after[p] - reference[p];
            }
            oldError += (old / 25) ** 2; newError += (current / 25) ** 2; count++;
          }
          rows.push({ downsample, angle, oldError: Math.sqrt(oldError / count),
            newError: Math.sqrt(newError / count) });
        }
        return { probes, rows, jitterStrength: volume.jitterStrength,
          sourceUnchanged: source.every((value, i) => value === red.density.data[i]) };
      });
      await fs.writeFile('/tmp/volume-sampling-regression.json', JSON.stringify({ result, errors }, null, 2));
      assert.deepEqual(errors, []);
      assert(result.probes.every(row => row.actual.every((value, i) => Math.abs(value - row.expected[i]) < 0.005)));
      assert(result.rows.every(row => row.newError < row.oldError), JSON.stringify(result.rows));
      assert.equal(result.jitterStrength, 1);
      assert(result.sourceUnchanged);
    } finally { await browser?.close(); await site.close(); }
  });
