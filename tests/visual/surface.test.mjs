import assert from 'node:assert/strict';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../scripts/site/dev.mjs';

const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
let browser;
try {
  browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${
    path.resolve(import.meta.dirname, 'fixtures/surface.html')}`);
  await page.waitForFunction(() => window.ready).catch(error => {
    throw new Error(`${error.message}\n${errors.join('\n')}`);
  });
  const samples = [{ position: [-0.25, 0, 0], color: [1, 0, 0] },
    { position: [0.25, 0, 0], color: [0, 0, 1] }];
  const merged = await page.evaluate(samples => window.seedSurface(samples), samples);
  console.log('Merged colored surface:', JSON.stringify(merged));
  assert(merged.triangles > 100);
  assert.equal(merged.components, 1);
  assert.equal(merged.openEdges, 0, 'brick boundaries must not crack');
  assert.equal(merged.invalid, 0);
  assert.equal(merged.reversed, 0);
  assert(merged.red > 0 && merged.blue > 0 && merged.mixed > 0);
  assert.equal(merged.overflowedBricks, 0);
  assert.equal(merged.overflowedTriangles, 0);
  assert.equal(merged.storageLimit, 8);
  const smoothed = await page.evaluate(async samples => {
    const { surface, renderer } = window.surfaceFixture;
    const snapshot = async () => new Float32Array(
      await renderer.getArrayBufferAsync(surface.surface.positionAttribute));
    const original = await snapshot();
    surface.smoothingIterations = 4;
    const result = await window.seedSurface(samples);
    const positions = await snapshot();
    let displacement = 0;
    for (let i = 0; i < positions.length; i += 4) {
      if (positions[i + 3] && original[i + 3]) {
        displacement = Math.max(displacement, Math.hypot(...positions.slice(i, i + 3)
          .map((value, axis) => value - original[i + axis])));
      }
    }
    surface.smoothingStrength = 0;
    const disabled = await window.seedSurface(samples);
    const disabledPositions = await snapshot();
    const identical = disabledPositions.every((value, index) => value === original[index]);
    surface.smoothingStrength = 1;
    surface.smoothingIterations = 0;
    return { result, displacement, identical, disabled };
  }, samples);
  console.log('Smoothed surface:', JSON.stringify(smoothed));
  assert.equal(smoothed.result.triangles, merged.triangles);
  assert.equal(smoothed.result.components, 1);
  assert.equal(smoothed.result.openEdges, 0);
  assert.equal(smoothed.result.invalid, 0);
  assert.equal(smoothed.result.reversed, 0);
  assert(smoothed.result.mixed > 0);
  assert(smoothed.result.normalVariation < merged.normalVariation);
  assert(Math.abs(smoothed.result.volume / merged.volume - 1) < 0.02, 'paired passes should limit volume change');
  assert(smoothed.displacement > 0 && smoothed.displacement < Math.sqrt(3) * 0.0625);
  assert(smoothed.identical, 'zero smoothing strength must preserve reconstruction');
  await page.screenshot({ path: '/tmp/rzmps-surface-desktop.png' });
  await page.setViewport({ width: 390, height: 720 });
  await page.evaluate(async () => {
    const { renderer, camera, scene } = window.surfaceFixture;
    renderer.setSize(390, 720);
    camera.aspect = 390 / 720;
    camera.updateProjectionMatrix();
    await renderer.renderAsync(scene, camera);
  });
  await page.screenshot({ path: '/tmp/rzmps-surface-mobile.png' });
  const separated = await page.evaluate(samples => window.seedSurface(samples), samples.map((sample, i) => ({
    ...sample, position: [i ? 0.8 : -0.8, 0, 0],
  })));
  assert.equal(separated.components, 2);
  assert.equal(separated.openEdges, 0);
  const smoothSeparated = await page.evaluate(async samples => {
    const { surface } = window.surfaceFixture;
    surface.smoothingIterations = 16;
    const result = await window.seedSurface(samples);
    surface.smoothingIterations = 0;
    return result;
  }, samples.map((sample, i) => ({ ...sample, position: [i ? 0.8 : -0.8, 0, 0] })));
  assert.equal(smoothSeparated.components, 2, 'smoothing must not join disconnected drops');
  assert.equal(smoothSeparated.openEdges, 0);
  assert.equal(smoothSeparated.invalid, 0);
  assert.equal(smoothSeparated.reversed, 0);
  const smallDrop = await page.evaluate(async () => {
    const { surface } = window.surfaceFixture;
    surface.smoothingIterations = 4;
    const result = await window.seedSurface([{ position: [0, 0, 0], color: [0, 1, 0], scale: [0.25, 0.25, 0.25] }]);
    surface.smoothingIterations = 0;
    return result;
  });
  assert(smallDrop.triangles > 0);
  assert.equal(smallDrop.components, 1);
  assert.equal(smallDrop.openEdges, 0);
  assert.equal(smallDrop.invalid, 0);
  assert.equal(smallDrop.reversed, 0);
  const empty = await page.evaluate(() => window.seedSurface([]));
  assert.equal(empty.triangles, 0);
  assert.equal(empty.vertices, 0);
  assert.equal(empty.draw[0], 0);
  const invisible = await page.evaluate(samples => window.seedSurface(samples.map(sample => ({ ...sample, alpha: 0 }))),
    samples);
  assert.equal(invisible.triangles, 0);
  const zeroSize = await page.evaluate(samples => window.seedSurface(samples.map(sample => ({
    ...sample, scale: [0, 0, 0],
  }))), samples);
  assert.equal(zeroSize.triangles, 0);
  const reused = await page.evaluate(samples => window.seedSurface(samples), samples);
  assert.equal(reused.triangles, merged.triangles);
  const filtered = await page.evaluate(async samples => {
    const { surface, system } = window.surfaceFixture;
    const red = system.getGPURendererTagMask(['red']);
    const blue = system.getGPURendererTagMask(['blue']);
    surface.tags = ['red'];
    const result = await window.seedSurface(samples.map((sample, i) => ({ ...sample, tagMask: i ? blue : red })));
    surface.tags = undefined;
    return result;
  }, samples);
  assert(filtered.red > 0);
  assert.equal(filtered.blue, 0);
  assert.equal(filtered.mixed, 0);
  const children = await page.evaluate(async samples => {
    const { surface } = window.surfaceFixture;
    surface.children = { count: 1, radius: 0, scale: 1, alpha: 1 };
    const result = await window.seedSurface(samples);
    surface.generateChildren = false;
    return result;
  }, samples);
  assert(children.vertices > merged.vertices, 'coincident children should increase reconstructed density');
  const transient = await page.evaluate(async samples => {
    const { surface, system, ColorOverLifetime, ScaleOverLifetime, THREE } = window.surfaceFixture;
    await window.seedSurface(samples);
    const color = new ColorOverLifetime({ color: new THREE.Color(0, 1, 0), alpha: 0.8 });
    const scale = new ScaleOverLifetime({ scale: new THREE.Vector3(0.8, 0.8, 0.8) });
    system.addModule(color);
    system.addModule(scale);
    system.advanceFrames(1, 1 / 60);
    const result = await window.readSurface();
    system.removeModule(color);
    system.removeModule(scale);
    return { result, compact: surface.surface.copyBuffers === system._gpuRenderOutputBuffers };
  }, samples);
  assert(transient.compact, 'surface must consume post-transient render storage');
  assert(transient.result.triangles > 0);
  assert.equal(transient.result.red, 0);
  assert.equal(transient.result.blue, 0);
  const clipped = await page.evaluate(() => window.seedSurface([
    { position: [10, 0, 0], color: [1, 0, 0] },
  ]));
  assert.equal(clipped.clippedParticles, 1);
  assert.equal(clipped.triangles, 0);
  const brickBudget = await page.evaluate(async samples => {
    const { surface } = window.surfaceFixture;
    surface.maxActiveBricks = 1;
    const limited = await window.seedSurface(samples);
    surface.maxActiveBricks = 128;
    const restored = await window.seedSurface(samples);
    return { limited, restored };
  }, samples);
  assert(brickBudget.limited.overflowedBricks > 0);
  assert.equal(brickBudget.limited.invalid, 0);
  assert.equal(brickBudget.restored.triangles, merged.triangles);
  const recovery = await page.evaluate(async samples => {
    const { surface } = window.surfaceFixture;
    surface.voxelSize = 0.001;
    let error;
    try { await window.seedSurface(samples); } catch (caught) { error = caught.message; }
    surface.voxelSize = 0.0625;
    return { error, restored: await window.seedSurface(samples) };
  }, samples);
  assert(recovery.error.includes('512 cells'));
  assert.equal(recovery.restored.triangles, merged.triangles);
  await page.evaluate(async samples => {
    const { surface, THREE } = window.surfaceFixture;
    surface.material = new THREE.MeshPhysicalMaterial({ transmission: 0.9, ior: 1.333, thickness: 0.3,
      attenuationColor: new THREE.Color('#b7e4ee'), attenuationDistance: 3 });
    await window.seedSurface(samples);
  }, samples);
  for (const directory of ['/src/gui', '/src/gui/particle-system-gui']) {
    const gui = await page.evaluate(async directory => {
      const { RendererGUI } = await import(`${directory}/RendererGUI.js`);
      const { ParticleSystemSerializer } = await import(`${directory}/ParticleSystemSerializer.js`);
      const { surface, system } = window.surfaceFixture;
      const keys = [];
      const controller = { name() { return this; } };
      const folder = { add(_target, key) { keys.push(key); return controller; }, addFolder() { return this; } };
      const context = { addTags() {}, addObject() {}, prettyName: key => key,
        addValue(_folder, _target, key) { keys.push(key); } };
      RendererGUI.prototype.buildRenderer.call(context, folder, surface, system);
      const code = new ParticleSystemSerializer({ system }).serializeRenderer(surface);
      return { keys, code };
    }, directory);
    assert(gui.keys.includes('voxelSize') && gui.keys.includes('particleColors'));
    assert(gui.keys.includes('smoothingIterations') && gui.keys.includes('smoothingStrength'));
    assert(!gui.keys.includes('surface') && !gui.keys.includes('projection') && !gui.keys.includes('geometry'));
    assert(gui.code.includes('new SurfaceRenderer(') && gui.code.includes('particleColors: true'));
    assert(gui.code.includes('smoothingIterations: 0') && gui.code.includes('smoothingStrength: 1'));
    assert(gui.code.includes('new THREE.MeshPhysicalMaterial(') && gui.code.includes('transmission: 0.9'));
    assert(gui.code.includes('attenuationDistance: 3') && gui.code.includes('attenuationColor:'));
  }
  const budget = await page.evaluate(async samples => {
    window.surfaceFixture.surface.maxTriangles = 10;
    window.surfaceFixture.surface.smoothingIterations = 4;
    return window.seedSurface(samples);
  }, samples);
  assert.equal(budget.triangles, 10);
  assert(budget.overflowedTriangles > 0);
  assert.equal(budget.invalid, 0);
  const cleanup = await page.evaluate(async () => {
    const { surface, renderer } = window.surfaceFixture;
    const helper = surface.surface;
    surface.destroy();
    return { detached: !surface.mesh.parent,
      fieldFreed: !renderer.backend.get(helper.fieldAttribute).buffer,
      smoothingFreed: !renderer.backend.get(helper.smoothingAttribute).buffer,
      topologyFreed: !renderer.backend.get(helper.topologyAttribute).buffer,
      indexFreed: !renderer.backend.get(helper.indexAttribute).buffer };
  });
  assert.deepEqual(cleanup, { detached: true, fieldFreed: true, smoothingFreed: true,
    topologyFreed: true, indexFreed: true });
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await site.close();
}
