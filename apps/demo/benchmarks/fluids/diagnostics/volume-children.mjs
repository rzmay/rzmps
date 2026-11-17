import { browserLaunchOptions } from '../../../../../scripts/browser/launch.utils.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../../../scripts/site/dev.mjs';
import { openFixture } from '../../../tests/fluids/openFixture.mjs';

const record = process.argv.includes('--record');
const output = process.argv[2] ?? '/tmp/rzmps-volume-children.json';
const baseline = record ? null : JSON.parse(await fs.readFile(output, 'utf8'));
const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
await site.demo.watcher.close();
let browser;
const results = {};
try {
  browser = await puppeteer.launch(browserLaunchOptions('diagnostic', { headless: true, args: [...browserLaunchOptions('diagnostic').args, '--enable-unsafe-webgpu'] }));
  for (const backend of ['webgl', 'webgpu']) {
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const fixture = path.resolve(import.meta.dirname, 'fixtures/volume.html');
    const url = `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}?backend=${backend}`;
    await openFixture(page, url, errors);
    results[backend] = await page.evaluate(async () => {
      const { volume, red, renderer, scene, camera, system } = window.volumeFixture;
      const n = 32;
      red.density.resolution.set(n, n, n);
      red.density.data = new Float32Array(n ** 3).fill(0.12); red.density.version++;
      red.color = { ...red.density, channels: 4, data: new Float32Array(n ** 3 * 4).fill(1) };
      Object.assign(volume, { tags: ['red'], generateChildren: true, densityMapping: 'Linear',
        dynamicResolution: false, emptySpaceSkipping: false, steps: 96, samplesPerVoxel: 2,
        jitterStrength: 1, densityNoiseStrength: 0, shadowQuality: 0, opacity: 0.5, depthTest: false,
        adaptiveStepping: false, transmittanceThreshold: 0 });
      let shader = '';
      if (renderer.isWebGPURenderer) {
        const device = renderer.backend.device, create = device.createShaderModule.bind(device);
        device.createShaderModule = descriptor => {
          if (descriptor.code.includes('@fragment')) shader = descriptor.code;
          return create(descriptor);
        };
      }
      const capture = () => {
        const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 80;
        const context = canvas.getContext('2d'); context.drawImage(renderer.domElement, 0, 0, 120, 80);
        return [...context.getImageData(0, 0, 120, 80).data];
      };
      const rows = [];
      for (const interpolation of ['Linear', 'Cubic']) for (const count of [0, 1, 4, 8]) {
        volume.interpolation = interpolation;
        volume.children = { count: [count, count], radius: 0, scale: 1, alpha: 0.5 };
        volume.update([], system, 0);
        if (renderer.isWebGPURenderer) await renderer.renderAsync(scene, camera); else renderer.render(scene, camera);
        const pixels = capture(), times = [];
        for (let i = 0; i < 3; i++) {
          if (renderer.isWebGPURenderer) {
            await renderer.renderAsync(scene, camera);
            await renderer.resolveTimestampsAsync('render');
            times.push(renderer.info.render.timestamp);
          } else renderer.render(scene, camera);
        }
        rows.push({ interpolation, count, pixels, layers: volume.layers.length,
          children: volume.renderedChildCount, logicalCenterRaySteps: 64,
          estimatedFieldEvaluations: 64 * (count + 1) * 2,
          estimatedTextureLookups: 64 * (count + 1) * 2 * (interpolation === 'Cubic' ? 8 : 1),
          shaderCharacters: renderer.isWebGPURenderer ? shader.length : volume.webglMaterial.fragmentShader.length,
          primaryRayLoops: renderer.isWebGPURenderer ? (shader.match(/volumeAccumulated = vec4/g) ?? []).length : 1,
          gpuMs: times.length ? times.sort((a, b) => a - b)[1] : null });
      }
      volume.children = { count: [4, 4], radius: 0.4, scale: [0.8, 1.2], alpha: [0.3, 0.7] };
      const transforms = () => volume.layers.flatMap(layer => (layer.children ?? [layer]).map(child => ({
        offset: child.offset.value.toArray(), scale: child.scale.value, alpha: child.alpha.value,
      })));
      volume.update([], system, 0); const first = transforms();
      volume.update([], system, 0); const repeated = transforms();
      return { rows, first, repeated };
    });
    const result = results[backend];
    assert.deepEqual(result.first, result.repeated, 'child transforms remain deterministic');
    if (baseline) {
      assert.deepEqual(result.first, baseline[backend].first, 'offset/scale/alpha preserve previous behavior');
    }
    for (const [index, row] of result.rows.entries()) {
      assert.equal(row.children, row.count);
      if (!record) {
        assert.equal(row.layers, 1, 'one provider must remain one layer');
        assert.equal(row.primaryRayLoops, 1);
        const previous = baseline[backend].rows[index];
        const difference = row.pixels.reduce((max, value, i) => Math.max(max, Math.abs(value - previous.pixels[i])), 0);
        assert(difference <= 2, `${backend}/${row.interpolation}/${row.count}: image difference ${difference}`);
      }
      const { pixels: _pixels, ...metrics } = row;
      console.log(JSON.stringify({ backend, ...metrics }));
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  await fs.writeFile(record ? output : output.replace(/\.json$/, '-after.json'), JSON.stringify(results));
} finally { await browser?.close(); await site.close(); }
