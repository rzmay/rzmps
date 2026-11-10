import assert from 'node:assert/strict';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../site/dev.mjs';

const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
let browser;
try {
  browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
  const page = await browser.newPage();
  page.setDefaultTimeout(240000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${
    path.resolve(import.meta.dirname, 'fixtures/fluid.html')}?demoLiquid&profile=true`);
  await page.waitForFunction(() => window.ready);
  const controls = await page.evaluate(() => {
    const { sceneLifecycle, scene, system, THREE } = window.debugFluid;
    const controllers = {};
    sceneLifecycle.gui({ add(target, key) {
      const control = { target, key, name() { return this; }, listen() { return this; },
        onChange(callback) { this.change = callback; return this; },
        set(value) { target[key] = value; this.change?.(value); } };
      controllers[key] = control;
      return control;
    } });
    window.tipControls = controllers;
    const pivot = scene.getObjectByName('Teapot Tip Pivot');
    const teapot = scene.getObjectByName('Lidless Utah Teapot');
    const collider = scene.getObjectByName('Utah Teapot Fluid Collider');
    const emitterPosition = system.getWorldPosition(new THREE.Vector3()).toArray();
    const initial = controllers.automaticTipping.target.automaticTipping;
    const defaults = { period: controllers.period.target.period, angle: controllers.maximumTip.target.maximumTip };
    controllers.tip.set(65);
    const noTeleport = pivot.rotation.z === 0;
    sceneLifecycle.update(1 / 60);
    const limitedStep = Math.abs(pivot.rotation.z) <= Math.PI * 0.5 / 180 + 1e-9;
    for (let i = 0; i < 30; i++) sceneLifecycle.update(0.1);
    scene.updateMatrixWorld(true);
    const matched = teapot.matrixWorld.equals(collider.getCollisionObject().matrixWorld);
    const minY = new THREE.Box3().setFromObject(teapot).min.y;
    const tip = pivot.rotation.z;
    sceneLifecycle.update(1);
    const manualHolds = pivot.rotation.z === tip;
    controllers.period.set(16);
    controllers.maximumTip.set(75);
    controllers.automaticTipping.set(true);
    for (let i = 0; i < 104; i++) sceneLifecycle.update(0.1);
    const automaticTip = pivot.rotation.z;
    controllers.automaticTipping.set(false);
    sceneLifecycle.update(5);
    const disabledHolds = pivot.rotation.z === automaticTip;
    controllers.automaticTipping.set(true);
    for (let i = 0; i < 160; i++) sceneLifecycle.update(0.1);
    const returnedUpright = Math.abs(pivot.rotation.z) < 1e-6;
    controllers.tip.set(0);
    for (let i = 0; i < 40; i++) sceneLifecycle.update(0.1);
    return { initial, defaults, noTeleport, limitedStep,
      matched, minY, manualHolds, automaticTip, disabledHolds, returnedUpright, emitterPosition,
      currentEmitterPosition: system.getWorldPosition(new THREE.Vector3()).toArray(),
      resolution: system.modules[0].resolution,
      maxParticles: system.maxParticles, duration: system.duration };
  });
  assert.equal(controls.initial, true);
  assert.deepEqual(controls.defaults, { period: 10, angle: 45 });
  assert(controls.noTeleport && controls.limitedStep, 'manual tipping must respect the angular speed limit');
  assert(controls.matched && controls.manualHolds && controls.disabledHolds);
  assert(controls.returnedUpright);
  assert(controls.minY > -0.44);
  assert(Math.abs(controls.automaticTip + Math.PI * 75 / 180) < 1e-6);
  assert.deepEqual(controls.currentEmitterPosition, controls.emitterPosition);
  assert.equal(controls.resolution, 128);
  assert.equal(controls.maxParticles, 32000);
  assert.equal(controls.duration, 0);
  const pour = await page.evaluate(async () => {
    const { renderer, system, flip, sceneLifecycle, scene, camera, THREE } = window.debugFluid;
    const spray = [...system.subSystems.keys()].find(child => child.name === 'Liquid Spray');
    for (let i = 0; i < 600; i++) {
      system.advanceFrames(1, 1 / 60);
      await renderer.resolveTimestampsAsync('compute');
    }
    const before = { ...flip.particleCollisionBackend.stats };
    system.stop(false);
    window.tipControls.period.set(32);
    window.tipControls.automaticTipping.set(true);
    for (let i = 0; i < 144; i++) sceneLifecycle.update(0.1);
    let spoutSamples = 0;
    let spraySamples = 0;
    const collider = scene.getObjectByName('Utah Teapot Fluid Collider');
    for (let i = 0; i < 468; i++) {
      sceneLifecycle.update(1 / 60);
      system.advanceFrames(1, 1 / 60);
      await renderer.resolveTimestampsAsync('compute');
      if (i % 60 === 0) {
        const droplets = (await spray.selectiveReadback(1500, ['position', 'velocity']))
          .filter(({ particle }) => particle.alive);
        spraySamples = Math.max(spraySamples, droplets.length);
        if (!droplets.every(({ particle }) => [...particle.position.toArray(), ...particle.velocity.toArray()]
          .every(Number.isFinite))) throw new Error('Spray must remain finite');
        const samples = await system.selectiveReadback(20000, ['position']);
        spoutSamples = Math.max(spoutSamples, samples.filter(({ particle }) => {
          if (!particle.alive) return false;
          const local = collider.worldToLocal(system.localToWorld(particle.position.clone()));
          return local.x > 2.3 && local.x < 3.6 && Math.abs(local.z) < 0.5 && local.y > 1;
        }).length);
      }
    }
    camera.position.set(6, 5, 8);
    camera.lookAt(0, 1, 0);
    await renderer.renderAsync(scene, camera);
    const particles = (await system.selectiveReadback(20000, ['position', 'velocity']))
      .filter(({ particle }) => particle.alive).map(({ particle }) => particle);
    const positions = particles.map(p => system.localToWorld(p.position.clone()));
    const alphaMap = spray.renderers[0].alphaMap;
    return { count: particles.length, spoutSamples, spraySamples,
      sprayGPU: spray.isGPUProcessingActive,
      sprayTexture: { width: alphaMap.image.width, height: alphaMap.image.height, url: alphaMap.image.src },
      spilled: positions.filter(p => p.y < -0.25 && p.x > 1.5).length,
      finite: particles.every(p => [...p.position.toArray(), ...p.velocity.toArray()].every(Number.isFinite)),
      tip: scene.getObjectByName('Teapot Tip Pivot').rotation.z,
      collider: { before, after: { ...flip.particleCollisionBackend.stats } },
      systemPosition: system.getWorldPosition(new THREE.Vector3()).toArray() };
  });
  console.log('Teapot tipping:', JSON.stringify({ controls, pour }));
  await page.screenshot({ path: '/tmp/rzmps-teapot-tipped.png' });
  await page.setViewport({ width: 390, height: 720 });
  const waterPixels = await page.evaluate(async () => {
    const { renderer, scene, camera, THREE } = window.debugFluid;
    const target = new THREE.Vector3(0, 1, 0);
    camera.position.sub(target).multiplyScalar((800 / 600) / (390 / 720)).add(target);
    camera.aspect = 390 / 720;
    camera.updateProjectionMatrix();
    renderer.setSize(390, 720);
    await renderer.renderAsync(scene, camera);
    const canvas = document.createElement('canvas');
    canvas.width = 390;
    canvas.height = 720;
    const context = canvas.getContext('2d');
    context.drawImage(renderer.domElement, 0, 0);
    const pixels = context.getImageData(0, 0, 390, 720).data;
    let water = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 1] > pixels[i] * 1.15 && pixels[i + 2] > pixels[i] * 1.3) water++;
    }
    return water;
  });
  await page.screenshot({ path: '/tmp/rzmps-teapot-tipped-mobile.png' });
  assert(waterPixels > 100, 'mobile view must contain rendered water');
  assert(pour.finite);
  assert(pour.sprayGPU && pour.spraySamples > 0, 'fast isolated liquid markers must generate GPU spray');
  assert(pour.sprayTexture.width > 0 && pour.sprayTexture.url.includes('spray_alpha.png'));
  assert(pour.spilled > 10, 'tipping must allow liquid to leave the vessel near the lowered spout');
  assert(pour.spoutSamples > 10, 'the actual teapot spout must carry liquid during tipping');
  assert(pour.collider.after.transformUpdates > pour.collider.before.transformUpdates);
  assert.equal(pour.collider.after.topologyRebuilds, pour.collider.before.topologyRebuilds);
  assert.equal(pour.collider.after.geometryRefits, pour.collider.before.geometryRefits);
  const cleanup = await page.evaluate(() => {
    const { system, sceneLifecycle, scene } = window.debugFluid;
    system.destroy();
    sceneLifecycle.cleanup();
    return { removed: !scene.getObjectByName('Fluid Teapot Scene'), environment: scene.environment === null };
  });
  assert.deepEqual(cleanup, { removed: true, environment: true });
  assert.deepEqual(errors, []);
} finally { await browser?.close(); await site.close(); }
