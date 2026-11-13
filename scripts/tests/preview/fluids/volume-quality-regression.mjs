import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../site/dev.mjs';
import { openFixture } from './openFixture.mjs';

const output = process.argv[2] ?? '/tmp/rzmps-volume-quality';
await fs.mkdir(output, { recursive: true });
const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
await site.demo.watcher.close();
let browser;
try {
  browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const fixture = path.resolve(import.meta.dirname, 'fixtures/fluid.html');
  await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}`
    + '?example=volumetricSmoke&scene=gasFlow&prepareStartup&measureStartup', errors);
  const result = await page.evaluate(async () => {
    const { system, renderer, scene, camera } = window.debugFluid;
    const volume = system.renderers[0];
    volume.dynamicResolution = false;
    for (let i = 0; i < 90; i++) system.advanceFrames(1, 1 / 60);
    await renderer.backend.device.queue.onSubmittedWorkDone();
    system.pause(false);
    const device = renderer.backend.device, create = device.createShaderModule.bind(device);
    const shaders = [];
    device.createShaderModule = descriptor => { shaders.push(descriptor.code); return create(descriptor); };
    const cases = [];
    for (const [name, options] of [
      ['full', { downsample: 1, emptySpaceSkipping: true, steps: 256, samplesPerVoxel: 2 }],
      ['no-skipping', { downsample: 1, emptySpaceSkipping: false }],
      ['half', { downsample: 2, emptySpaceSkipping: true }],
      ['no-mask', { downsample: 1, densityNoiseStrength: 0 }],
      ['midpoint', { densityNoiseStrength: 1.3, jitterStrength: 0 }],
      ['one-sample', { jitterStrength: 1, steps: 128, samplesPerVoxel: 1 }],
      ['high-sampling', { jitterStrength: 1, steps: 512, samplesPerVoxel: 4 }],
      ['full-restored', { downsample: 1, emptySpaceSkipping: true, jitterStrength: 1,
        steps: 256, samplesPerVoxel: 2 }],
    ]) {
      Object.assign(volume, options); system.updateRenderers();
      const start = performance.now();
      await renderer.renderAsync(scene, camera);
      const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 600;
      const context = canvas.getContext('2d'); context.drawImage(renderer.domElement, 0, 0);
      const pixels = [...context.getImageData(0, 0, 800, 600).data];
      await device.queue.onSubmittedWorkDone();
      cases.push({ name, pixels, image: canvas.toDataURL(), firstRenderMs: performance.now() - start,
        shaderCharacters: shaders.filter(code => code.includes('@fragment')).map(code => code.length) });
      shaders.length = 0;
    }
    return { cases, scale: volume.dynamicTarget.resolutionScale };
  });
  const full = result.cases[0].pixels;
  const referencePixels = result.cases.find(item => item.name === 'high-sampling').pixels;
  for (const item of result.cases) {
    let max = 0, changed = 0, sum = 0;
    item.pixels.forEach((value, i) => { const d = Math.abs(value - full[i]); max = Math.max(max, d);
      sum += d; if (d > 2) changed++; });
    item.difference = { max, changed, mean: sum / full.length };
    item.referenceError = item.pixels.reduce((sum, value, i) => sum + Math.abs(value - referencePixels[i]), 0)
      / item.pixels.length;
    await fs.writeFile(path.join(output, `${item.name}.png`), Buffer.from(item.image.split(',')[1], 'base64'));
    delete item.pixels; delete item.image;
  }
  assert.equal(result.cases.find(item => item.name === 'full-restored').difference.max, 0,
    'restoring ray quality must reproduce the frozen image exactly');
  assert.equal(result.cases.find(item => item.name === 'high-sampling').shaderCharacters.length, 0,
    'ray quality edits must reuse the render pipeline');
  assert(result.cases[0].referenceError < result.cases.find(item => item.name === 'one-sample').referenceError,
    'two-sample demo quality must converge closer to the four-sample reference');
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'metrics.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await browser?.close(); await site.close(); }
