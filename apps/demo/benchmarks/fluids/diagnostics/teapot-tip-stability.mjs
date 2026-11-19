import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { browserLaunchOptions } from '../../../../../scripts/browser/launch.utils.mjs';
import { startSiteDev } from '../../../../../scripts/site/dev.mjs';
import { openFixture } from '../../../tests/fluids/openFixture.mjs';

const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
await site.demo.watcher.close();
let browser;
try {
  browser = await puppeteer.launch(browserLaunchOptions('diagnostic', { protocolTimeout: 180000 }));
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const fixture = path.resolve('apps/demo/tests/fluids/fixtures/fluid.html');
  await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}`
    + '?demoLiquid&measureStartup&prepareStartup', errors);
  const result = await page.evaluate(async options => {
    const { renderer, scene, camera, system, flip, sceneLifecycle, THREE } = window.debugFluid;
    const { readLiquidMarkers, markerMetrics } = await import(options.qualityURL);
    const model = scene.getObjectByName('Lidless Utah Teapot'), pivot = scene.getObjectByName('Teapot Tip Pivot');
    const pivotHeight = pivot.position.y, points = [], inverse = pivot.matrixWorld.clone().invert();
    model.traverse(object => {
      if (!object.isMesh) return;
      const matrix = inverse.clone().multiply(object.matrixWorld), positions = object.geometry.attributes.position;
      for (let i = 0; i < positions.count; i++) {
        points.push(new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(matrix));
      }
    });
    let diagnosticTime = 0;
    let previousHeight = pivot.position.y;
    const sweep = flip.computeMovingWalls;
    if (options.variant === 'no-sweep') flip.computeMovingWalls = function (...args) {
      if (diagnosticTime < 28) return sweep.apply(this, args);
    };
    const samples = [];
    for (let frame = 0; frame < Math.round(40 / options.dt); frame++) {
      diagnosticTime = (frame + 1) * options.dt;
      sceneLifecycle.update(options.dt);
      if (options.variant === 'mesh-floor' && diagnosticTime >= 28) {
        const sine = Math.sin(pivot.rotation.z), cosine = Math.cos(pivot.rotation.z);
        const lowest = Math.min(...points.map(p => p.x * sine + p.y * cosine));
        pivot.position.y = Math.max(pivotHeight, -0.43 - lowest);
        pivot.updateWorldMatrix(true, true);
      }
      const liftSpeed = (pivot.position.y - previousHeight) / options.dt;
      previousHeight = pivot.position.y;
      system.advanceFrames(1, options.dt);
      await renderer.renderAsync(scene, camera);
      await renderer.backend.device.queue.onSubmittedWorkDone();
      const time = (frame + 1) * options.dt;
      const tipping = (time >= 8 && time <= 18) || (time >= 28 && time <= 38);
      if (frame % Math.round((tipping ? 0.25 : 1) / options.dt) !== 0) continue;
      const markers = await readLiquidMarkers(system, renderer), metrics = markerMetrics(markers);
      const speed = markers.map(p => Math.hypot(...p.velocity)).sort((a, b) => a - b);
      const local = model.matrixWorld.clone().invert().multiply(system.getSimulationToWorldMatrix());
      let rising = 0, maxUp = 0, highest = -Infinity;
      const point = new THREE.Vector3();
      for (const marker of markers) {
        maxUp = Math.max(maxUp, marker.velocity[1]);
        rising += Number(marker.velocity[1] > 2);
        point.fromArray(marker.position).applyMatrix4(local);
        if (Math.abs(point.x) < 1.5 && Math.abs(point.z) < 1.5) highest = Math.max(highest, point.y);
      }
      const pressure = await flip.getPressureProjection().readDiagnostics(renderer, flip.velocityCurrent);
      samples.push({ time, angle: -THREE.MathUtils.radToDeg(pivot.rotation.z), ...metrics,
        maxUp, rising, speed95: speed[Math.floor(speed.length * 0.95)], highest, liftSpeed,
        pivotHeight: pivot.position.y,
        pressure, cellWidth: flip.cellSize, capacity: flip.workGrid.capacity,
        wallDt: flip.boundaryDt.value, quality: flip.qualityPreparation?.phase,
        motionPadding: flip.particleCollisionBackend.motionPadding.value,
        objects: { ...flip.particleCollisionBackend.stats } });
    }
    return { dt: options.dt, variant: options.variant, samples };
  }, { dt: Number(process.env.FLIP_TIP_DT ?? 1 / 60), variant: process.env.FLIP_TIP_VARIANT ?? 'normal',
    qualityURL: `/@fs${path.resolve('apps/demo/benchmarks/fluids/liquidQuality.utils.js')}` });
  await fs.writeFile(process.argv[2] ?? '/tmp/teapot-tip-stability.json',
    JSON.stringify({ ...result, errors }, null, 2));
  assert.deepEqual(errors, []);
  if (process.env.FLIP_TIP_ASSERT === '1') {
    const motion = result.samples.filter(sample => sample.time >= 29 && sample.time <= 32);
    assert(motion.every(sample => sample.nonFiniteSamples === 0 && sample.pressure.nonFiniteSamples === 0));
    assert(Math.max(...motion.map(sample => sample.rising / sample.particles)) < 0.01,
      'second-tip upward burst must not involve a significant fraction of the liquid');
  }
  console.log(JSON.stringify({ ...result, samples: result.samples.sort((a, b) => b.maxUp - a.maxUp).slice(0, 8),
    errors }, null, 2));
} finally { await browser?.close(); await site.close(); }
