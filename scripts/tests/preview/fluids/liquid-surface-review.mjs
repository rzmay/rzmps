import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../site/dev.mjs';

const output = process.argv[2] ?? '/tmp/rzmps-liquid-surface';
await fs.mkdir(output, { recursive: true });
const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
let browser;
try {
  browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
  const page = await browser.newPage();
  page.setDefaultTimeout(180000);
  await page.setViewport({ width: 800, height: 600 });
  await page.exposeFunction('captureLiquidCheckpoint', async frame => {
    await page.screenshot({ path: path.join(output, `teapot-${frame}.png`) });
  });
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${
    path.resolve(import.meta.dirname, 'fixtures/fluid.html')}?example=flipFluid&profile=true&demoLiquid`);
  await page.waitForFunction(() => window.ready).catch(error => {
    throw new Error(`${error.message}\n${errors.join('\n')}`);
  });
  const frames = Number(process.env.SURFACE_FRAMES ?? 960);
  const result = await page.evaluate(async frames => {
    const { renderer, system, scene, camera } = window.debugFluid;
    const surface = system.renderers.find(renderer => renderer.constructor.name === 'SurfaceRenderer');
    if (!surface) throw new Error('FLIP preset must use a surface renderer');
    const timestampUID = renderer.backend.getTimestampUID;
    const update = surface._updateGPU;
    let meshing = false, dispatches = [], dispatchIndex = 0;
    surface._updateGPU = function (...args) {
      meshing = true;
      try { return update.apply(this, args); } finally { meshing = false; }
    };
    renderer.backend.getTimestampUID = function (...args) {
      // Repeated smoothing/pressure dispatches otherwise overwrite the same timestamp-query key.
      const uid = timestampUID.apply(this, args).replace(/:f(\d+)$/, `-pass${dispatchIndex++}:f$1`);
      if (meshing) dispatches.push(uid);
      return uid;
    };
    const samples = [], checkpoints = [];
    for (let frame = 1; frame <= frames; frame++) {
      dispatches = [];
      dispatchIndex = 0;
      system.advanceFrames(1, 1 / 60);
      const updateMs = await renderer.resolveTimestampsAsync('compute');
      if (frame > frames - 30) {
        const timestamps = renderer.backend.timestampQueryPool.compute.timestamps;
        samples.push({ updateMs, surfaceMs: dispatches.reduce((sum, uid) => sum + (timestamps.get(uid) ?? 0), 0) });
      }
      if ([120, 360, 480, 720, frames].includes(frame)) {
        await renderer.renderAsync(scene, camera);
        checkpoints.push({ frame, ...(await surface.readSurfaceDiagnostics()) });
        await window.captureLiquidCheckpoint(frame);
      }
    }
    const motion = await renderer.getArrayBufferAsync(surface.surface.positionAttribute);
    system.advanceFrames(1, 1 / 60);
    await renderer.resolveTimestampsAsync('compute');
    const nextMotion = await renderer.getArrayBufferAsync(surface.surface.positionAttribute);
    const before = new Float32Array(motion), after = new Float32Array(nextMotion);
    const moving = before.some((value, index) => value !== after[index]);
    renderer.backend.getTimestampUID = timestampUID;
    surface._updateGPU = update;
    const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    return { samples, checkpoints, moving, medianGPUUpdateMs: median(samples.map(s => s.updateMs)),
      medianGPUSurfaceMs: median(samples.map(s => s.surfaceMs)) };
  }, frames);
  const checkPixels = () => page.evaluate(async () => {
    const { renderer, camera, scene } = window.debugFluid;
    await renderer.renderAsync(scene, camera);
    const canvas = document.createElement('canvas');
    canvas.width = renderer.domElement.width;
    canvas.height = renderer.domElement.height;
    const context = canvas.getContext('2d');
    context.drawImage(renderer.domElement, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let waterPixels = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 1] > pixels[i] * 1.15 && pixels[i + 2] > pixels[i] * 1.3) waterPixels++;
    }
    return waterPixels;
  });
  assert(result.moving, 'the primary liquid mesh must update as the simulation advances');
  result.desktopWaterPixels = await checkPixels();
  assert(result.desktopWaterPixels > 100);
  await page.screenshot({ path: path.join(output, 'teapot-desktop.png') });
  await page.setViewport({ width: 390, height: 720 });
  await page.evaluate(async () => {
    const { renderer, camera, scene } = window.debugFluid;
    renderer.setSize(390, 720);
    const target = new window.debugFluid.THREE.Vector3(0, 0.6, 0);
    camera.position.sub(target).multiplyScalar((800 / 600) / (390 / 720)).add(target);
    camera.aspect = 390 / 720;
    camera.updateProjectionMatrix();
    await renderer.renderAsync(scene, camera);
  });
  result.mobileWaterPixels = await checkPixels();
  assert(result.mobileWaterPixels > 100);
  await page.screenshot({ path: path.join(output, 'teapot-mobile.png') });
  for (const checkpoint of result.checkpoints) {
    assert(checkpoint.triangles > 0);
    assert.equal(checkpoint.overflowedTriangles, 0);
    assert.equal(checkpoint.overflowedBricks, 0);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(result, null, 2));
  await fs.writeFile(path.join(output, 'metrics.json'), JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  await site.close();
}
