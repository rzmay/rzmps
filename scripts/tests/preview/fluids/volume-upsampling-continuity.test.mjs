import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../site/dev.mjs';
import { openFixture } from './openFixture.mjs';

test('depth-aware upsampling never drops all volume samples at narrow opaque-depth gaps',
  { timeout: 60000 }, async () => {
    const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
    await site.demo.watcher.close();
    let browser;
    try {
      browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const fixture = path.resolve(import.meta.dirname, 'fixtures/volume.html');
      const url = `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}?backend=webgpu`;
      await openFixture(page, url, errors);
      const result = await page.evaluate(async () => {
        const { volume, red, renderer, scene, camera, system, THREE } = window.volumeFixture;
        const w = 481, h = 321;
        renderer.setSize(w, h); camera.aspect = w / h; camera.position.set(0, 0, 4);
        camera.lookAt(0, 0, 0); camera.updateProjectionMatrix();
        red.density.bounds.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
        red.density.data.fill(0.8); red.density.version++;
        Object.assign(volume, { tags: ['red'], generateChildren: false, dynamicResolution: false,
          densityNoiseStrength: 0, densityMapping: 'Linear', opacity: 0.9, jitter: false,
          steps: 128, samplesPerVoxel: 2, softParticles: false, transmittanceThreshold: 0 });
        const pixelWidth = 2 * 4 * Math.tan(camera.fov * Math.PI / 360) / h;
        const geometry = new THREE.PlaneGeometry(pixelWidth * 3.5, 4);
        const material = new THREE.MeshBasicMaterial({ color: 0 });
        for (let i = -30; i <= 30; i++) {
          const strip = new THREE.Mesh(geometry, material); strip.position.x = i * pixelWidth * 4;
          scene.add(strip);
        }
        const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
        const context = canvas.getContext('2d');
        const capture = async divisor => {
          volume.downsample = divisor; volume.update([], system, 0); await renderer.renderAsync(scene, camera);
          if (volume.dynamicTarget.targets.size > 2) throw new Error('Volume target cache grew without bound');
          context.drawImage(renderer.domElement, 0, 0); return context.getImageData(0, 0, w, h).data;
        };
        const full = await capture(1), results = [];
        for (const divisor of [1.25, 1.5, 2, 3]) {
          const reduced = await capture(divisor); let holes = 0, visible = 0;
          for (let y = 70; y < h - 70; y++) for (let x = 140; x < w - 140; x++) {
            const offset = (x + w * y) * 4;
            if (full[offset] > 20) { visible++; if (reduced[offset] < 2) holes++; }
          }
          results.push({ divisor, visible, holes });
        }
        // No fallback may borrow rear fog through a foreground occluder just because the proxy box starts in front.
        const n = red.density.resolution.x;
        for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
          red.density.data[x + n * (y + n * z)] = z < n / 2 - 1 ? 0.8 : 0;
        }
        red.density.version++;
        const rearFull = await capture(1), rearReduced = await capture(3);
        let leaks = 0;
        for (let y = 70; y < h - 70; y++) for (let x = 140; x < w - 140; x++) {
          const offset = (x + w * y) * 4;
          if (rearFull[offset] === 0 && rearReduced[offset] > 8) leaks++;
        }
        const target = volume.dynamicTarget.targets.get(1 / 3);
        const raw = await renderer.readRenderTargetPixelsAsync(target, 0, 0, target.width, target.height, 1);
        let minFirst = Infinity, maxFirst = -Infinity, minScene = Infinity, maxScene = -Infinity;
        for (let i = 0; i < raw.length; i += 4) if (THREE.DataUtils.fromHalfFloat(raw[i + 3]) > 0) {
          const first = THREE.DataUtils.fromHalfFloat(raw[i + 1]), scene = THREE.DataUtils.fromHalfFloat(raw[i]);
          minFirst = Math.min(minFirst, first); maxFirst = Math.max(maxFirst, first);
          minScene = Math.min(minScene, scene); maxScene = Math.max(maxScene, scene);
        }
        results.push({ rearFog: true, leaks, minFirst, maxFirst, minScene, maxScene });
        window.upsamplingShaders = [...renderer._nodes.nodeBuilderCache.values()]
          .map(state => state.fragmentShader).filter(shader => shader?.includes('volumeFirstOpacityDepth'));
        await capture(1);
        if (volume.dynamicTarget.targets.size !== 0) throw new Error('Full resolution retained unused targets');
        geometry.dispose(); material.dispose(); return results;
      });
      await fs.writeFile('/tmp/volume-upsampling-continuity.json', JSON.stringify({ result, errors }, null, 2));
      await fs.writeFile('/tmp/volume-upsampling.wgsl', await page.evaluate(() => window.upsamplingShaders.join('\n')));
      assert.deepEqual(errors, []);
      assert(result.every(row => row.rearFog ? row.leaks === 0 : row.visible > 100 && row.holes === 0),
        JSON.stringify(result));
    } finally { await browser?.close(); await site.close(); }
  });
