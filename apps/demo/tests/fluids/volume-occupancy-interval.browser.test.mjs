import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { createServer } from 'vite';
import { browserLaunchOptions } from '../../../../scripts/browser/launch.utils.mjs';
import { openFixture } from './openFixture.mjs';

test('cached occupancy intervals preserve jittered rays through empty regions and rotated children',
  { timeout: 60000 }, async () => {
    const server = await createServer({ root: path.resolve(import.meta.dirname, '../..'),
      server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
    let browser;
    try {
      await server.listen(); await server.watcher.close();
      browser = await puppeteer.launch(browserLaunchOptions('test'));
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await openFixture(page,
        `http://127.0.0.1:${server.httpServer.address().port}/tests/fluids/fixtures/volume.html?backend=webgpu`, errors);
      const result = await page.evaluate(async () => {
        const { red, volume, camera, renderer, THREE, gpu } = window.volumeFixture;
        const size = 64, data = new Float32Array(size ** 3);
        for (let z = 0; z < size; z++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
          const radius = Math.hypot(x - 19, y - 32, z - 38);
          data[x + size * (y + size * z)] = Math.max(0, 1 - radius / 11);
        }
        red.density.data = data;
        red.density.resolution = new THREE.Vector3(size, size, size);
        red.density.version++;
        Object.assign(volume, { dynamicResolution: false, downsample: 1, emissive: 1,
          emptySpaceSkipping: true, jitterStrength: 1, depthTest: false, steps: 160, samplesPerVoxel: 2 });
        const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 320;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        const capture = () => {
          context.drawImage(renderer.domElement, 0, 0);
          return context.getImageData(0, 0, 480, 320).data.slice();
        };
        const scenarios = [];
        for (const children of [false, true]) for (const inside of [false, true]) {
          volume.generateChildren = children;
          volume.children = { count: 1, radius: 0.2, rotation: new THREE.Vector3(0.3, 0.1, 0.6) };
          camera.position.set(inside ? -0.89 : 0, 0, inside ? 0.1 : 6);
          camera.lookAt(-0.89, 0, -1);
          await window.renderVolume(['red']);
          const cached = capture(), retained = volume.webgpuMaterial, interval = volume.emptyInterval;
          const sampleVolume = volume.sampleVolume;
          volume.emptyInterval = function (...args) {
            const value = interval.apply(this, args);
            return gpu.vec4(value.x, 0, 0, 0).xy;
          };
          volume.sampleVolume = function (position, includeColor) {
            return sampleVolume.call(this, position, includeColor);
          };
          volume.webgpuMaterial = volume.createWebGPUMaterial();
          await renderer.renderAsync(window.volumeFixture.scene, camera);
          const reference = capture();
          let maximum = 0, changed = 0, visible = 0;
          for (let i = 0; i < cached.length; i++) {
            const difference = Math.abs(cached[i] - reference[i]);
            maximum = Math.max(maximum, difference);
            if (difference > 2) changed++;
            if (i % 4 !== 3 && cached[i] > 0) visible++;
          }
          scenarios.push({ children, inside, maximum, changed, visible });
          volume.webgpuMaterial.dispose(); volume.webgpuMaterial = retained; volume.emptyInterval = interval;
          volume.sampleVolume = sampleVolume;
        }
        return scenarios;
      });
      console.log('Occupancy reconstruction:', JSON.stringify(result));
      assert(result.every(row => row.visible > 100), 'all views exercise visible density');
      assert(result.every(row => row.maximum <= 2 && row.changed === 0), 'cache preserves the reference sampling lattice');
      assert.deepEqual(errors, []);
    } finally { await browser?.close(); await server.close(); }
  });
