import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import test from 'node:test';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import { browserLaunchOptions } from '../../../scripts/browser/launch.utils.mjs';

test('heat laser floor/wall emissions, occupancy and focused stage timings', { timeout: 90000 }, async () => {
  const server = await createServer({ root: path.resolve(import.meta.dirname, '..'),
    server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
  let browser;
  try {
    await server.listen(); await server.watcher.close();
    browser = await puppeteer.launch(browserLaunchOptions('test'));
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/heatLaser.html`);
    await page.waitForFunction(() => window.ready, { timeout: 60000 });
    const result = await page.evaluate(async timerURL => {
      const { passTimer } = await import(timerURL);
      const { system, renderer, scene, camera, THREE } = window.laser;
      const demo = system.userData.heatLaser, children = [...system.subSystems.keys()];
      const debris = children.find(child => child.name === 'Laser Debris');
      const gasSystem = children.find(child => child.name === 'Laser Fire and Smoke');
      let stage = 'unscoped', currentCase = '', recording = false, born = 0, collisions = 0;
      const cpu = {}, rawFrames = [], cases = [];
      const owners = new Map();
      for (const owner of [system, ...children]) {
        owners.set(owner.benchmarks, owner.name);
        owners.set(owner.gpuSimulation.benchmarks, `${owner.name}/GPU`);
        for (const component of [...owner.modules, ...owner.renderers, ...owner.emitters])
          owners.set(component.benchmarks, `${owner.name}/${component.constructor.name}`);
      }
      const volume = gasSystem.renderers.find(view => view.lightingGrid);
      if (volume?.lightingGrid) {
        system.benchmarks.attach('lighting', volume.lightingGrid.benchmarks);
        owners.set(volume.lightingGrid.benchmarks, 'lighting');
      }
      const prototype = Object.getPrototypeOf(system.benchmarks), begin = prototype.begin;
      prototype.begin = function (name) {
        const previous = stage, label = `${owners.get(this) ?? 'other'}/${name}`;
        stage = label;
        const started = performance.now(), finish = begin.call(this, name);
        return () => {
          if (recording) (cpu[`${currentCase}/${label}`] ??= []).push(performance.now() - started);
          stage = previous; finish?.();
        };
      };
      const timer = renderer.backend.device.features.has('timestamp-query')
        ? passTimer(renderer.backend.device, renderer.backend, () => stage) : null;
      const initialize = debris.initializeParticle.bind(debris);
      debris.initializeParticle = (...args) => { born++; return initialize(...args); };
      const unsubscribe = system.onEvent('collision', () => { collisions++; });
      system.benchmarks.start({ maxSamples: 256 });
      for (const [name, target] of [['wall', new THREE.Vector3(-2, 2, -3)],
        ['floor', new THREE.Vector3(-2, 0, 3)]]) {
        currentCase = name;
        demo.aimAt(target);
        const before = born, beforeCollisions = collisions, beforePipelines = window.laser.pipelineBuilds();
        let belowFloor = 0, peak = 0;
        for (let frame = 0; frame < 240; frame++) {
          await new Promise(requestAnimationFrame);
          recording = frame >= 180;
          const timed = recording && frame % 6 === 0 && timer?.start();
          const started = performance.now();
          system.advanceFrames(1, 1 / 60);
          stage = 'scene rendering';
          await renderer.renderAsync(scene, camera);
          stage = 'unscoped';
          const lighting = gasSystem.renderers.find(view => view.lightingGrid)?.lightingGrid;
          if (lighting && !owners.has(lighting.benchmarks)) {
            system.benchmarks.attach('lighting', lighting.benchmarks);
            owners.set(lighting.benchmarks, 'lighting');
          }
          if (recording) rawFrames.push(performance.now() - started);
          if (timed) cases.push({ scene: name, gpu: await timer.finish() });
          peak = Math.max(peak, debris.particles.filter(p => p.alive).length);
          belowFloor += debris.particles.filter(p => p.alive && p.position.y < -0.1).length;
          system.benchmarks.frame();
        }
        const counters = await gasSystem.gpuSimulation._gpuAllocationBuffer.readback(renderer);
        const buffers = gasSystem.gpuParticleBuffers;
        const state = new Uint32Array(await renderer.getArrayBufferAsync(buffers.attributes.uintData));
        let liveSlots = 0;
        for (let i = 0; i < buffers.capacity; i++) if (state[i * 4]) liveSlots++;
        cases.push({ scene: name, allocationActive: counters.activeCount, liveSlots,
          pipelineBuilds: window.laser.pipelineBuilds() - beforePipelines,
          residentBricks: demo.gas.brickDiagnostics.resident, cellWidth: demo.gas.cellSize,
          born: born - before, collisions: collisions - beforeCollisions,
          peak, belowFloor, particles: debris.particles.slice(0, 4).map(p => ({
            position: p.position.toArray(), velocity: p.velocity.toArray() })),
          collisionRadius: debris.modules.find(module => 'radiusScale' in module)?.radiusScale,
          occupancy: gasSystem.gpuBufferStats,
          bounds: [demo.gas.bounds.min.toArray(), demo.gas.bounds.max.toArray()] });
      }
      // Freeze simulation state and compare rendering with/without only the volume draw.
      recording = false;
      if (timer) {
        const mesh = gasSystem.renderers.find(view => view.lightingGrid)?.mesh;
        const mask = mesh.layers.mask;
        for (const visible of [true, false]) {
          mesh.layers.mask = visible ? mask : 0;
          for (let frame = 0; frame < 8; frame++) {
            await new Promise(requestAnimationFrame);
            timer.start(); stage = 'frozen scene rendering';
            await renderer.renderAsync(scene, camera);
            cases.push({ scene: visible ? 'render-only/volume' : 'render-only/no-volume', gpu: await timer.finish() });
          }
        }
        mesh.layers.mask = mask;
      }
      const report = system.benchmarks.stop();
      prototype.begin = begin; unsubscribe(); timer?.dispose();
      return { cases, cpu, rawFrames, report, preparationMs: window.laser.preparationMs, errors: window.laser.errors };
    }, `/@fs${path.resolve('benchmarks/lib/passTimer.js')}`);
    await writeFile('/tmp/heat-laser-performance.json', JSON.stringify(result, null, 2));
    console.log('Heat laser cases:', JSON.stringify(result.cases.filter(row => row.born !== undefined)
      .map(row => ({ scene: row.scene, born: row.born, collisions: row.collisions,
        live: row.liveSlots, allocated: row.occupancy.allocated }))));
    assert.deepEqual(errors, []); assert.deepEqual(result.errors, []);
    const cases = result.cases.filter(row => row.born !== undefined);
    assert(cases.every(row => row.collisions > 100 && row.born >= 20));
    assert(cases.every(row => row.collisionRadius < 0.1 && row.belowFloor === 0));
    assert(cases.every(row => row.occupancy.activeSlots <= row.occupancy.allocated));
    assert(cases.every(row => row.allocationActive === row.liveSlots), 'GPU allocation counters match live slot bits');
  } finally { await browser?.close(); await server.close(); }
});
