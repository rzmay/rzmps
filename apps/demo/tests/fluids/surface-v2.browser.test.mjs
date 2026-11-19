import { browserLaunchOptions } from '../../../../scripts/browser/launch.utils.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../../scripts/site/dev.mjs';
import { openFixture } from './openFixture.mjs';

const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
await site.demo.watcher.close();
let browser;
try {
  browser = await puppeteer.launch(browserLaunchOptions('test', { headless: true,
    args: [...browserLaunchOptions('test').args, '--enable-unsafe-webgpu'] }));
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  page.on('console', value => {
    if (value.type() === 'error') { errors.push(value.text()); console.error(value.text()); }
  });
  await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${
    path.resolve(import.meta.dirname, 'fixtures/surface.html')}`, errors);
  const samples = [];
  for (const x of [-0.3, 0, 0.3]) for (const y of [-0.3, 0, 0.3]) for (const z of [-0.3, 0, 0.3]) {
    samples.push({ position: [x, y, z], scale: [0.5, 0.5, 0.5], color: [0.2, 0.5, 1], velocity: [1, 2, 3] });
  }
  for (const extraction of ['SurfaceNets', 'MarchingCubes']) for (const anisotropy of [0, 0.7]) {
    const result = await page.evaluate(async ({ samples, extraction, anisotropy }) => {
      window.expectedVelocity = [1, 2, 3];
      return window.reconstructSurface(samples, { extraction, anisotropy, particleRadius: 0.65,
        maxActiveBricks: 512, fieldSmoothingIterations: 1, fieldClosing: 0.15 });
    }, { samples, extraction, anisotropy });
    console.log(extraction, anisotropy, JSON.stringify(result));
    assert(result.triangles > 0);
    assert.equal(result.invalid, 0);
    assert(result.maxVelocityError < 1e-4);
    assert(result.maxCurl < 1e-3, 'constant flow must not create spurious surface curl');
    assert.equal(result.overflowedBricks, 0);
    assert.equal(result.overflowedTriangles, 0);
  }
  // Move the same surface across sparse page boundaries: neither method may lose pieces.
  for (const extraction of ['SurfaceNets', 'MarchingCubes']) {
    const results = [];
    for (const shift of [0, 0.5, -0.5]) {
      results.push(await page.evaluate(async ({ samples, extraction, shift }) => {
        const translated = samples.map(sample => ({ ...sample,
          position: sample.position.map(value => value + shift) }));
        return window.reconstructSurface(translated, { extraction, anisotropy: 0,
          particleRadius: 0.65, fieldClosing: 0, fieldSmoothingIterations: 0 });
      }, { samples, extraction, shift }));
    }
    for (const result of results) {
      assert.equal(result.triangles, results[0].triangles, 'page-aligned translation preserves extraction');
      assert.equal(result.invalid, 0);
      assert.equal(result.overflowedBricks, 0);
      assert.equal(result.overflowedTriangles, 0);
    }
  }
  // A user factory can wrap either built-in and can be replaced without changing any numeric option.
  for (const method of ['buildSurfaceNets', 'buildMarchingCubes']) {
    const result = await page.evaluate(async ({ samples, method }) => {
      const builtin = window.surfaceFixture[method];
      const custom = Object.assign(context => builtin(context), { vertexLayout: builtin.vertexLayout });
      return window.reconstructSurface(samples, { extraction: custom, anisotropy: 0, particleRadius: 0.65 });
    }, { samples, method });
    assert(result.triangles > 0, method);
    assert.equal(result.invalid, 0, method);
    assert.equal(result.overflowedBricks, 0, method);
  }
  for (const mode of ['stationary', 'linear', 'rotation', 'isolated', 'coincident']) {
    const particles = mode === 'isolated'
      ? [{ position: [0.012, 0.024, 0.035], scale: [0.08, 0.08, 0.08], color: [1, 0.5, 0] }]
      : samples.map(sample => ({ ...sample,
        position: mode === 'coincident' ? [0, 0, 0] : sample.position,
        velocity: mode === 'linear' ? sample.position : mode === 'rotation'
          ? [-sample.position[1], sample.position[0], 0] : [0, 0, 0],
      }));
    const result = await page.evaluate(async ({ particles, mode }) => {
      window.expectedVelocity = ['stationary', 'isolated', 'coincident'].includes(mode) ? [0, 0, 0] : undefined;
      window.expectedLinearVelocity = mode === 'linear';
      return window.reconstructSurface(particles, { extraction: 'SurfaceNets', anisotropy: 0.7,
        anisotropyMaxStretch: 2, particleRadius: 1.55, fieldClosing: 0, fieldSmoothingIterations: 1 });
    }, { particles, mode });
    assert(result.triangles > 0, mode);
    assert.equal(result.invalid, 0, mode);
    if (mode === 'stationary' || mode === 'isolated' || mode === 'coincident') {
      assert(result.maxVelocityError < 1e-6, mode);
      assert(result.maxCurl < 1e-6, mode);
    }
    if (mode === 'linear') {
      assert(result.maxLinearError < 0.65, 'linear field remains bounded near support edges');
      assert(result.maxVelocityJump < 0.3, 'linear velocity interpolates continuously across mesh edges');
    }
    if (mode === 'rotation') assert(result.maxCurl > 0.1, 'reconstruct curl from rotating particle motion');
    console.log(mode, JSON.stringify({ triangles: result.triangles, invalid: result.invalid,
      velocityError: result.maxVelocityError, linearError: result.maxLinearError,
      velocityJump: result.maxVelocityJump, curl: result.maxCurl }));
  }
  const materials = await page.evaluate(() => window.testSurfaceComposites());
  for (const pixel of [materials.gpu, materials.gl]) assert(
    pixel[0] > 50 && pixel[0] > pixel[1] * 3 && pixel[0] > pixel[2] * 3,
    'existing composite callbacks read reconstructed surface speed on both shader backends');
  assert(materials.code.includes('new SurfaceRenderer.LiquidMaterial('));
  assert(materials.code.includes('normalStrength:') && materials.code.includes('gradient:'));
  assert(materials.code.includes('influenceRadius:') && materials.code.includes('fieldSmoothing:'));
  console.log('Surface composites:', JSON.stringify({ gpu: materials.gpu, webgl: materials.gl }));
  const liquid = await page.evaluate(() => window.testLiquidMaterial());
  assert(liquid.calm[0] > liquid.calm[1] * 3, 'calm endpoint uses the first gradient color');
  assert.deepEqual(liquid.moving, liquid.calm, 'uniform speed alone does not activate aeration');
  for (const active of [liquid.deforming, liquid.rotating]) {
    assert(active[1] > active[0] * 3, 'deformation or sufficiently strong curl reaches the active color');
  }
  assert(liquid.rough[0] > liquid.smooth[0] + 100, 'roughness function evaluates across activity');
  assert(liquid.reusedGeometry && liquid.replacedCallback, 'flow edits update appearance without rebuilding geometry');
  console.log('Built-in liquid material:', JSON.stringify(liquid));
  const growth = await page.evaluate(() => window.testAutomaticSurfaceGrowth());
  console.log('Automatic surface growth:', JSON.stringify(growth));
  assert(growth.retainedWhilePreparing && growth.swapped, 'growth swaps only after separate preparation');
  assert(growth.after.allocatedBytes > growth.before.allocatedBytes);
  assert(growth.after.triangles > 0);
  assert.equal(growth.after.overflowedBricks, 0);
  assert.equal(growth.after.overflowedTriangles, 0);
  assert.deepEqual(errors, []);
} finally { await browser?.close(); await site.close(); }
