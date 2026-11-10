import path from 'node:path';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../site/dev.mjs';

const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
let browser;
try {
  browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
  const page = await browser.newPage();
  page.setDefaultTimeout(180000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${
    path.resolve(import.meta.dirname, 'fixtures/fluid.html')}?profile=true`);
  await page.waitForFunction(() => window.ready);
  const measurements = await page.evaluate(async () => {
    const { system, flip, renderer } = window.debugFluid;
    const checkpoints = [];
    for (let frame = 0; frame < 1800; frame++) {
      system.advanceFrames(1, 1 / 60);
      await renderer.resolveTimestampsAsync('compute');
      if ([119, 359, 719, 959, 1799].includes(frame)) {
        const particles = (await system.selectiveReadback(16000, ['position', 'velocity']))
          .filter(({ particle }) => particle.alive).map(({ particle }) => particle);
        const sortedY = particles.map(p => p.position.y).sort((a, b) => a - b);
        const vesselY = sortedY.filter(y => y < -1.25);
        checkpoints.push({ frame: frame + 1, bounds: flip.bounds.getSize(new window.debugFluid.THREE.Vector3()).x,
          count: particles.length, top: sortedY[Math.floor(sortedY.length * 0.95)],
          vesselTop: vesselY[Math.floor(vesselY.length * 0.95)],
          rmsSpeed: Math.sqrt(particles.reduce((sum, p) => sum + p.velocity.lengthSq(), 0) / particles.length),
          packing: await window.fluidPacking() });
      }
    }
    const restarts = [];
    for (const control of ['stop-clear-start', 'reset', 'clear-start']) {
      if (control === 'reset') system.reset();
      else {
        if (control === 'stop-clear-start') system.stop(true);
        else system.clearParticles();
        system.start();
      }
      const surface = system.renderers.find(renderer => renderer.constructor.name === 'SurfaceRenderer');
      for (let frame = 0; frame < 120; frame++) {
        system.advanceFrames(1, 1 / 60);
        await renderer.resolveTimestampsAsync('compute');
      }
      const particles = (await system.selectiveReadback(16000, ['position']))
        .filter(({ particle }) => particle.alive);
      restarts.push({ control, count: particles.length,
        spread: Math.max(...particles.map(({ particle }) => particle.position.x))
          - Math.min(...particles.map(({ particle }) => particle.position.x)),
        packing: await window.fluidPacking(), surface: await surface.readSurfaceDiagnostics() });
    }
    return { checkpoints, restarts };
  });
  console.log(JSON.stringify({ measurements, errors }, null, 2));
  assert.deepEqual(errors, []);
  for (const checkpoint of measurements.checkpoints) assert.equal(checkpoint.bounds, 8);
  const settled = measurements.checkpoints.at(-1);
  assert(settled.rmsSpeed < 0.1, 'resting liquid must not sustain strong bulk circulation');
  assert(settled.packing.medianSpacing > 0.9);
  assert(settled.packing.compressed < 0.02);
  for (const restart of measurements.restarts) {
    assert(restart.count > 800 && restart.count < 1000, restart.control);
    assert(restart.spread > 1, `${restart.control}: liquid must spread into the vessel`);
    assert(restart.surface.triangles > 1000, `${restart.control}: surface must grow after restarting`);
    assert.equal(restart.surface.overflowedTriangles, 0);
  }
} finally {
  await browser?.close();
  await site.close();
}
