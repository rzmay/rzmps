import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { PNG } from 'pngjs';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import { browserLaunchOptions } from '../../../scripts/browser/launch.utils.mjs';

test('heat laser composes collision effects, contact reheating, spacing and persistent source cleanup',
  { timeout: 120000 }, async () => {
    const server = await createServer({ root: path.resolve(import.meta.dirname, '..'),
      server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
    let browser;
    try {
      await server.listen(); await server.watcher.close();
      browser = await puppeteer.launch(browserLaunchOptions('test', { protocolTimeout: 120000 }));
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/heatLaser.html`);
      await page.waitForFunction(() => window.ready, { timeout: 60000 });
      const result = await page.evaluate(async () => {
        const { system, scene, lifecycle, THREE, renderer, StorageBufferAttribute,
          createGPUParticleBufferState, tsl } = window.laser;
        const { Fn, float, bool, uint, vec4, storage } = tsl;
        const demo = system.userData.heatLaser;
        const sphere = scene.userData.wallAndSphere.sphere;
        const target = sphere.position.clone().add(new THREE.Vector3(0, 0, 1.5));
        demo.aimAt(target);
        const first = await window.runLaser(90), decal = demo.burns.decals[0];
        const source = decal.source;
        const [densityBytes, colorBytes] = await Promise.all([
          renderer.getArrayBufferAsync(demo.gas.densityCurrent.value),
          renderer.getArrayBufferAsync(demo.gas.colorCurrent.value),
        ]);
        const density = new Float32Array(densityBytes), colors = new Float32Array(colorBytes);
        let sampledCells = 0, colorError = 0;
        for (let i = 0; i < density.length; i += 4) {
          if (density[i] < 0.001) continue;
          sampledCells++;
          for (let channel = 0; channel < 3; channel++)
            colorError = Math.max(colorError, Math.abs(colors[i + channel] / density[i] - 1));
        }
        const fumes = [...system.subSystems.keys()].find(child => child.name === 'Laser Fire and Smoke');
        const spread = fumes.modules.find(module => module.initializeParticle);
        const spreadSample = age => {
          const particle = system.particles[0].clone();
          particle.velocity.set(0.7, 0.6, 0);
          spread.initializeParticle(particle, { system: fumes, source: { age, lifetime: 16 } });
          return particle.velocity.toArray();
        };
        const spreadVelocity = { hot: spreadSample(0), cool: spreadSample(8) };
        const reheatEmitter = fumes.emitters.find(emitter => emitter.onEvent?.reheat);
        const spawnReheat = reheatEmitter.spawnParticle.bind(reheatEmitter);
        let reheatBirths = 0, invalidReheatSources = 0;
        reheatEmitter.spawnParticle = (...args) => {
          const particle = spawnReheat(...args);
          if (particle) {
            reheatBirths++;
            if (args[2].source !== source) invalidReheatSources++;
          }
          return particle;
        };
        const cooling = fumes.modules.find(module => module.initialize);
        const sampleParticle = system.particles[0].clone();
        system.bindParticleSource(sampleParticle, source);
        const emission = { density: 2, temperature: 4, color: new THREE.Color('white'), velocity: new THREE.Vector3() };
        cooling.initialize([sampleParticle], emission, {});
        const coolingError = Math.abs(emission.temperature / 4 - (1 - source.age / source.lifetime) ** 3);
        const count = demo.burns.count;
        const limiter = system.modules.find(module => module.priority === 0.5);
        const probe = system.particles[0].clone();
        probe.position.copy(system.emitters[0].initialValues.position);
        const nearSurvives = !limiter.condition(probe);
        probe.position.x += 100;
        const farRejected = !!limiter.condition(probe);
        const margin = demo.controls.beamLengthPadding;
        demo.controls.beamLengthPadding = 200;
        const marginRespected = !limiter.condition(probe);
        demo.controls.beamLengthPadding = margin;
        limiter._modify(probe);
        const beamLimit = { nearSurvives, farRejected, marginRespected, killed: !probe.alive };
        const scorch = demo.scorches.decals[0];
        const scorchOpacity = scorch.renderedOpacity;
        demo.scorches.update([], system, 1);
        const scorchFade = { before: scorchOpacity, after: scorch.renderedOpacity,
          ownsSource: !!scorch.source, cap: demo.scorches.maxDecals };
        // Leave the cold mark alive throughout beam travel before the next contact.
        decal.age = decal.lifetime * 0.75;
        demo.controls.enabled = false; await window.runLaser(2);
        const coldHeat = 1 - source.age / source.lifetime, age = decal.age, lifetime = decal.lifetime;
        demo.controls.enabled = true;
        await window.runLaser(45);
        emission.temperature = emission.density = 1;
        cooling.initialize([sampleParticle], emission, {});
        const heatOutput = new StorageBufferAttribute(new Float32Array(4), 4);
        const heatTarget = storage(heatOutput, 'vec4', 1);
        // Probe the contacted source explicitly; a live allocation's slot zero can already have died/recycled.
        fumes.bindParticleSource(sampleParticle, source);
        const buffers = createGPUParticleBufferState([sampleParticle], 1);
        demo.gas.sourceData.update(fumes);
        const heatNode = Fn(() => {
          const particle = demo.gas.sourceData.particle(buffers.storage.createParticle(), buffers);
          const heated = { density: float(1).toVar(), temperature: float(1).toVar() };
          cooling.initializeGPU({ length: float(1), forEach(callback) {
            callback({ source: particle.source, tagMask: uint(0) });
          } }, heated, {});
          const burst = { density: float(1).toVar(), temperature: float(1).toVar() };
          cooling.initializeGPU({ length: float(1), forEach(callback) {
            callback({ source: particle.source, tagMask: uint(fumes.getGPUFilterTagMask(['laser-reheat'])) });
          } }, burst, {});
          heatTarget.element(0).assign(vec4(heated.temperature, burst.temperature, 0, 0));
        })().compute(1);
        renderer.compute(heatNode);
        const heatValues = new Float32Array(await renderer.getArrayBufferAsync(heatOutput));
        const gpuHeat = heatValues[0], burstHeat = heatValues[1];
        heatNode.dispose(); heatOutput.dispose(); buffers.dispose();
        const reheated = { age, lifetime, ageAfter: decal.age, lifetimeAfter: decal.lifetime,
          heat: 1 - source.age / source.lifetime, coldHeat,
          temperatureFactor: emission.temperature, gpuHeat, burstHeat, reheatBirths, invalidReheatSources,
          same: demo.burns.decals[0] === decal, count: demo.burns.count };
        demo.aimAt(sphere.position.clone().add(new THREE.Vector3(0.35, 0, 1.5)));
        const beforeMove = system.emitters[0].initialValues.velocity();
        await window.runLaser(4);
        const intermediate = system.emitters[0].initialValues.velocity();
        await window.runLaser(15);
        const finalPosition = system.emitters[0].initialValues.velocity();
        const smoothing = { firstStep: intermediate.distanceTo(beforeMove),
          remaining: intermediate.distanceTo(finalPosition), distance: beforeMove.distanceTo(finalPosition) };
        demo.aimAt(new THREE.Vector3(-1, 0, 2.5));
        const moved = await window.runLaser(45);
        const oldAlive = source.alive;
        demo.controls.enabled = false;
        const lingering = await window.runLaser(60);
        beamLimit.staleHitExpires = !limiter.condition(probe);
        decal.age = decal.lifetime - 0.05;
        await window.runLaser(2);
        const cooled = { retained: demo.burns.decals.includes(decal), heat: 1 - source.age / source.lifetime };
        const sources = demo.burns.decals.map(item => item.source);
        demo.burns.clear();
        const orphanEmission = { density: 2, temperature: 4, color: new THREE.Color('white'),
          velocity: new THREE.Vector3() };
        cooling.initialize([sampleParticle], orphanEmission, {});
        const orphanOutput = new StorageBufferAttribute(new Float32Array(4), 4);
        const orphanTarget = storage(orphanOutput, 'vec4', 1);
        const orphanNode = Fn(() => {
          const emission = { density: float(2).toVar(), temperature: float(4).toVar() };
          cooling.initializeGPU({ length: float(1), forEach(callback) {
            callback({ tagMask: uint(0), source: { valid: bool(false), age: float(0), lifetime: float(1) } });
          } }, emission, {});
          orphanTarget.element(0).assign(vec4(emission.density, emission.temperature, 0, 0));
        })().compute(1);
        renderer.compute(orphanNode);
        const orphanGPU = [...new Float32Array(await renderer.getArrayBufferAsync(orphanOutput))];
        orphanNode.dispose(); orphanOutput.dispose();
        const bindings = [];
        const folder = { addFolder() { return this; }, add(object, key) {
          const entry = { object, key }; bindings.push(entry);
          return { onChange(callback) { entry.change = callback; } };
        } };
        lifecycle.gui(folder);
        const x = bindings.find(entry => entry.key === 'x');
        x.object.x += 0.4; x.change();
        const manualX = sphere.position.x;
        const motion = bindings.find(entry => entry.key === 'automaticMotion');
        motion.object.automaticMotion = true;
        lifecycle.update(2);
        const sceneControls = { manualX, animatedX: sphere.position.x,
          receivers: scene.userData.wallAndSphere.receivers.length };
        const metadata = scene.userData.wallAndSphere;
        delete scene.userData.wallAndSphere;
        system.particles.forEach(particle => particle.kill());
        demo.controls.enabled = true;
        demo.aimAt(new THREE.Vector3(-2, 0, 3));
        const previousCollisions = demo.statistics.collisions;
        await window.runLaser(30);
        const otherScene = { particles: system.particles.filter(particle => particle.alive).length,
          collisions: demo.statistics.collisions - previousCollisions,
          rate: system.emitters[0].rate(), burns: demo.burns.count };
        scene.userData.wallAndSphere = metadata;
        return { first, reheated, moved, lingering, smoothing, sceneControls, scorchFade, count, oldAlive, cooled,
          otherScene, beamLimit, sampledCells, colorError, spreadVelocity, coolingError, orphanEmission, orphanGPU,
          sourcesRemoved: sources.every(item => !item.alive), errors: window.laser.errors };
      });
      console.log('Laser lifecycle:', JSON.stringify({ firstFrameMs: result.first.frameMs,
        movingFrameMs: result.moved.frameMs, stationaryMarks: result.count, smoothing: result.smoothing,
        reheated: result.reheated,
        beams: result.first.beams, sourcesRemoved: result.sourcesRemoved }));
      assert(result.otherScene.rate === 600 && result.otherScene.particles > 0
        && result.otherScene.collisions > 0 && result.otherScene.burns > 0,
      'emission and collision effects must work without preferred-scene metadata');
      assert.equal(result.count, 1, 'stationary contact retains one spaced mark');
      assert(result.sampledCells > 0, 'registered decal sources deposit visible gas');
      assert(Object.values(result.beamLimit).every(Boolean), JSON.stringify(result.beamLimit));
      assert(result.coolingError < 1e-12);
      assert.equal(result.orphanEmission.density, 0);
      assert.equal(result.orphanEmission.temperature, 0);
      assert.deepEqual(result.orphanGPU, [0, 0, 0, 0]);
      assert(result.spreadVelocity.hot[0] > result.spreadVelocity.cool[0]);
      assert.equal(result.spreadVelocity.hot[1], 0.6);
      assert.equal(result.spreadVelocity.cool[1], 0.6);
      assert(result.colorError < 0.001, `specific gas color must survive density decay: ${result.colorError}`);
      assert(result.scorchFade.after < result.scorchFade.before && result.scorchFade.before <= 0.45);
      assert(!result.scorchFade.ownsSource && result.scorchFade.cap >= 256);
      assert(result.first.particles.length > 10, 'the ribbon must contain moving beam particles');
      assert.equal(result.first.groupingBuilds,
        result.first.preparedGroupingBuilds,
        'ordinary interaction reuses the prepared light-grouping programs');
      assert.equal(result.first.children.length, 3, 'only sparks, debris and decal gas are subsystems');
      assert(result.first.children.find(child => child.name === 'Laser Sparks').particles > 0);
      assert(result.first.children.find(child => child.name === 'Laser Debris').particles > 0);
      assert(result.first.children.find(child => child.name === 'Laser Fire and Smoke').gpu);
      assert(result.first.particles.flat().every(Number.isFinite));
      assert(result.first.collisions > 0);
      assert(result.first.children.find(child => child.name === 'Laser Fire and Smoke').lights.some(value => value > 0),
        'hot gas particles must drive active flame lights');
      assert(result.first.beams.every(beam => beam.vertices >= 4 && beam.side === 2));
      assert(result.lingering.children.find(child => child.name === 'Laser Fire and Smoke').particles > 0,
        'burn sources continue emitting after the beam stops');
      assert(result.reheated.same && result.reheated.count === 1);
      assert(result.reheated.reheatBirths > 0, 'stationary contact must generate additional reheat bursts');
      assert.equal(result.reheated.invalidReheatSources, 0, 'reheat bursts retain the contacted decal source');
      assert(result.reheated.ageAfter < 1 / 60, 'beam contact restarts the decal cooling clock');
      assert.equal(result.reheated.lifetimeAfter, result.reheated.lifetime,
        'reheating retains the normal cooling duration');
      assert(result.reheated.heat > result.reheated.coldHeat);
      assert(result.reheated.burstHeat > 1.99, 'reheat particles deposit hotter gas than ordinary emission');
      assert(result.reheated.gpuHeat > 0.99, 'the contacted source must emit at full heat on GPU');
      assert(result.reheated.temperatureFactor > 0.99, 'the contacted source must emit at full heat on CPU');
      assert(Math.abs(result.reheated.gpuHeat - result.reheated.temperatureFactor) < 0.02);
      assert(result.moved.burns > 1 && result.oldAlive);
      assert(result.cooled.retained && result.cooled.heat < 0.005);
      assert(result.sourcesRemoved);
      assert(result.smoothing.firstStep > 0 && result.smoothing.remaining > 0.02);
      assert(result.smoothing.firstStep < result.smoothing.distance);
      assert.equal(result.sceneControls.receivers, 3);
      assert(Math.abs(result.sceneControls.animatedX - result.sceneControls.manualX) > 0.5);
      assert.deepEqual(result.errors, []);
      assert.deepEqual(errors, []);
    } finally { await browser?.close(); await server.close(); }
  });


test('live demo emits a collision-driven particle ribbon and actually draws the laser',
  { timeout: 90000 }, async () => {
  const server = await createServer({ root: path.resolve(import.meta.dirname, '..'),
    server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
  let browser;
  try {
    await server.listen(); await server.watcher.close();
    browser = await puppeteer.launch(browserLaunchOptions('test'));
    const page = await browser.newPage(), errors = [];
    await page.setViewport({ width: 1280, height: 800 });
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => request.url().startsWith('https://avatars.githubusercontent.com/')
      ? request.abort() : request.continue());
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    await page.goto(`${origin}/?preset=Heat%20Laser&scene=Wall%20and%20Sphere&renderer=webgpu`);
    await page.waitForSelector('.psgui-renderers');
    await page.evaluate(async () => {
      // Inspect the actual React root, including asynchronous initial scene replacement.
      const url = performance.getEntriesByType('resource').find(entry =>
        entry.name.includes('@react-three_fiber.js')).name;
      const { _roots } = await import(url);
      const state = _roots.get(document.querySelector('canvas')).store.getState();
      let system;
      state.scene.traverse(object => { if (object.userData.heatLaser) system = object; });
      window.laserLive = { system, state };
    });
    await page.waitForFunction(() => window.laserLive.system.particles.filter(p => p.alive).length > 10);
    const oldIds = await page.evaluate(() => {
      const particles = window.laserLive.system.particles;
      const ids = particles.map(p => p.id);
      particles.forEach(p => { p.alive = false; });
      return { ids, collisions: window.laserLive.system.userData.heatLaser.statistics.collisions };
    });
    await page.waitForFunction(previous => {
      const particles = window.laserLive.system.particles.filter(p => p.alive);
      return particles.length > 10 && particles.every(p => !previous.ids.includes(p.id))
        && window.laserLive.system.userData.heatLaser.statistics.collisions > previous.collisions + 20;
    }, {}, oldIds);
    const canvas = await page.evaluate(() => {
      const { system, state } = window.laserLive;
      system.pause();
      const rect = state.gl.domElement.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const visible = PNG.sync.read(Buffer.from(await page.screenshot()));
    await page.evaluate(() => {
      window.laserLive.system.renderers.slice(0, 2).forEach(view => { view.material.colorWrite = false; });
      window.laserLive.state.invalidate();
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const hidden = PNG.sync.read(Buffer.from(await page.screenshot()));
    let difference = 0;
    for (let y = Math.max(0, Math.floor(canvas.top)); y < Math.min(visible.height, canvas.bottom); y++) {
      for (let x = Math.max(0, Math.floor(canvas.left)); x < Math.min(visible.width, canvas.right); x++) {
        const index = (y * visible.width + x) * 4;
        difference = Math.max(difference, visible.data[index] - hidden.data[index]);
      }
    }
    assert(difference > 40, `the beam must contribute visible pixels: ${JSON.stringify({ canvas, difference })}`);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await server.close(); }
});
