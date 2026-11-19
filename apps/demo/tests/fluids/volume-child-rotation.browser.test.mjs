import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { browserLaunchOptions } from '../../../../scripts/browser/launch.utils.mjs';
import { startSiteDev } from '../../../../scripts/site/dev.mjs';
import { openFixture } from './openFixture.mjs';

test('volume children rotate color/density on both backends and rotate GPU velocity/occupancy queries',
  { timeout: 60000 }, async () => {
    const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
    await site.demo.watcher.close();
    let browser;
    try {
      browser = await puppeteer.launch(browserLaunchOptions('test'));
      for (const backend of ['webgl', 'webgpu']) {
        const page = await browser.newPage(), errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        const fixture = path.resolve(import.meta.dirname, 'fixtures/volume.html');
        const url = `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}?backend=${backend}`;
        await openFixture(page, url,
          errors);
        const result = await page.evaluate(async gpu => {
          const { red, volume, THREE, renderer } = window.volumeFixture;
          red.density.bounds.min.set(-1.2, -0.15, -0.3); red.density.bounds.max.set(1.2, 0.15, 0.3);
          for (let i = 0; i < red.color.data.length; i += 4)
            red.color.data.set(i / 4 % 8 < 4 ? [1, 0, 0, 1] : [0, 0, 1, 1], i);
          red.color.version++;
          Object.assign(volume, { generateChildren: true, emissive: 1, jitterStrength: 0,
            depthTest: false, sceneDepthClipping: false, dynamicResolution: false,
            downsample: 1, emptySpaceSkipping: false,
            children: { count: 1, radius: 0, rotation: new THREE.Vector3() } });
          const pixels = async () => {
            await window.renderVolume(['red']);
            const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 320;
            const context = canvas.getContext('2d'); context.drawImage(renderer.domElement, 0, 0);
            return [95, 225].map(y => [...context.getImageData(240, y, 1, 1).data]);
          };
          const unrotated = await pixels();
          volume.children.rotation.z = Math.PI / 2;
          const rotated = await pixels(), bounds = [volume.bounds.min.toArray(), volume.bounds.max.toArray()];
          const material = volume.webgpuMaterial;
          volume.children.rotation.z = -Math.PI / 2;
          const reversed = await pixels(), retainedMaterial = material === volume.webgpuMaterial;
          const velocity = [];
          let skipped = null;
          if (gpu) {
            const { Fn, storage, vec3, vec4, StorageBufferAttribute } = window.volumeFixture.gpu;
            volume.emptySpaceSkipping = true;
            skipped = await pixels();
            red.density.sampleVelocityGPU = () => vec3(1, 0, 0);
            const attribute = new StorageBufferAttribute(new Float32Array(4), 4);
            const output = storage(attribute, 'vec4', 1);
            const node = Fn(() => output.element(0).assign(vec4(
              volume.sampleGasVelocity(vec3(0, 0.65, 0), vec3(1).x), 1)))().compute(1);
            renderer.compute(node);
            velocity.push(...new Float32Array(await renderer.getArrayBufferAsync(attribute)));
            node.dispose(); renderer.backend.destroyAttribute(attribute); attribute.dispose();
          }
          return { unrotated, rotated, reversed, bounds, retainedMaterial, velocity, skipped };
        }, backend === 'webgpu');
        assert(result.unrotated.every(pixel => Math.max(...pixel.slice(0, 3)) < 5));
        assert(result.rotated[0][2] > 30 && result.rotated[0][2] > result.rotated[0][0], backend);
        assert(result.rotated[1][0] > 30 && result.rotated[1][0] > result.rotated[1][2], backend);
        assert(result.reversed[0][0] > result.reversed[0][2]);
        assert(result.reversed[1][2] > result.reversed[1][0]);
        assert(Math.abs(result.bounds[1][1] - 1.2) < 1e-8);
        assert(result.retainedMaterial);
        if (backend === 'webgpu') {
          assert(Math.abs(result.velocity[0]) < 1e-5 && Math.abs(result.velocity[1] + 1) < 1e-5);
          assert(result.skipped.every((pixel, i) => pixel.every((value, c) =>
            Math.abs(value - result.reversed[i][c]) <= 3)), 'occupancy traversal must follow the rotated child');
        }
        assert.deepEqual(errors, []);
        await page.close();
      }
    } finally { await browser?.close(); await site.close(); }
  });
