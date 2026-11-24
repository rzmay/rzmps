import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import test from 'node:test';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import { browserLaunchOptions } from '../../../scripts/browser/launch.utils.mjs';

test('authored burn/scorch batches scale with decal count and overlap independently of gas',
  { timeout: 120000 }, async () => {
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
        const { system, renderer, scene, camera, THREE, DecalRenderer, ParticleSystem } = window.laser;
        renderer.setRenderTarget(null); renderer.setSize(1280, 800);
        camera.aspect = 1280 / 800; camera.position.set(0, 2, 5); camera.lookAt(0, 2, -3);
        camera.updateProjectionMatrix();
        const wall = scene.userData.wallAndSphere.wall;
        scene.userData.wallAndSphere.sphere.visible = false;
        const prototype = Object.getPrototypeOf(system.benchmarks), begin = prototype.begin;
        let stage = 'render';
        prototype.begin = function (name) {
          const previous = stage, end = begin.call(this, name);
          stage = name;
          return () => { stage = previous; end?.(); };
        };
        const timer = renderer.backend.device.features.has('timestamp-query')
          ? passTimer(renderer.backend.device, renderer.backend, () => stage) : null;
        if (!timer) throw new Error('GPU timestamps required for decal diagnostic');
        const createOwner = async () => {
          const views = [system.userData.heatLaser.burns, system.userData.heatLaser.scorches].map((view, index) =>
            new DecalRenderer(view.material.clone(), { onSpawn: false, onCollision: true,
              emissionTags: index === 0 ? ['burn'] : [], maxDecals: 8192, minDistance: 0,
              duplicateDistance: 0, inheritMaterial: false,
              size: 0.8, depth: 0.2, offset: 0.008, lifetime: 120, opacity: 0.5 }));
          const owner = new ParticleSystem({
            gpuProcessing: false, emitters: [], renderers: views, gravityModifier: 0 });
          scene.add(owner); await renderer.renderAsync(scene, camera);
          owner.benchmarks.start();
          const source = owner.registerEmissionSource({ tags: ['probe'],
            transform: new THREE.Matrix4().makeTranslation(0, 2, -2.9) });
          return { owner, views, source };
        };
        const rows = [];
        for (const pattern of ['spread', 'overlap']) for (const count of [128, 512, 2048]) {
          const { owner, views, source } = await createOwner();
          const started = performance.now();
          for (let i = 0; i < count; i++) {
            const x = pattern === 'spread' ? (i % 32) / 31 * 6 - 3 : (i % 8) * 0.002;
            const y = pattern === 'spread' ? Math.floor(i / 32) % 32 / 31 * 4 + 0.2 : 2;
            source.emitEvent('collision', { object: wall, material: wall.material,
              point: new THREE.Vector3(x, y, -3), normal: new THREE.Vector3(0, 0, 1),
              impulse: new THREE.Vector3(0, 0, 1) });
          }
          const creationMs = performance.now() - started, updates = [], samples = [], queryTimes = [];
          for (let frame = 0; frame < 10; frame++) {
            await new Promise(requestAnimationFrame);
            const before = performance.now(); owner.advanceFrames(1, 1 / 60);
            updates.push(performance.now() - before);
            const queryStarted = performance.now();
            for (let query = 0; query < 10; query++)
              views[0].queryDecals(wall, new THREE.Vector3(0, 2, -3), 2.24, new THREE.Vector3(0, 0, 1));
            queryTimes.push(performance.now() - queryStarted);
            timer.start(); await renderer.renderAsync(scene, camera); samples.push(await timer.finish());
          }
          const meshes = [...new Set(views.flatMap(view => view.decals.map(decal => decal.mesh)))];
          for (const mesh of meshes) mesh.layers.mask = 0;
          const hidden = [];
          for (let frame = 0; frame < 4; frame++) {
            timer.start(); await renderer.renderAsync(scene, camera); hidden.push(await timer.finish());
          }
          rows.push({ pattern, countPerLayer: count, live: views.map(view => view.count),
            creationMs, updates, queryTimes,
            batches: views.map(view => view.batchDiagnostics), samples, hidden });
          owner.destroy();
        }
        const growth = [], complexity = [];
        const { owner, views, source } = await createOwner();
        let previous = performance.now();
        for (let count = 1; count <= 257; count++) {
          await new Promise(requestAnimationFrame);
          const now = performance.now(), beforePipelines = window.laser.renderPipelineBuilds();
          const before = performance.now();
          source.emitEvent('collision', { object: wall, material: wall.material,
            point: new THREE.Vector3((count % 16) * 0.02, 2, -3),
            normal: new THREE.Vector3(0, 0, 1), impulse: new THREE.Vector3(0, 0, 1) });
          const creationMs = performance.now() - before;
          owner.advanceFrames(1, 1 / 60);
          const submitted = performance.now(); await renderer.renderAsync(scene, camera);
          growth.push({ countPerLayer: count, interval: now - previous, creationMs,
            renderSubmissionMs: performance.now() - submitted,
            renderPipelines: window.laser.renderPipelineBuilds() - beforePipelines,
            batches: views.map(view => view.batchDiagnostics) });
          previous = now;
        }
        owner.destroy();
        const originalGeometry = wall.geometry;
        for (const subdivisions of [1, 32, 256]) {
          wall.geometry = new THREE.PlaneGeometry(14, 7, subdivisions, subdivisions);
          const { owner, source } = await createOwner();
          const creationMs = [];
          for (let i = 0; i < 8; i++) {
            const before = performance.now();
            source.emitEvent('collision', { object: wall, material: wall.material,
              point: new THREE.Vector3(i * 0.02, 2, -3), normal: new THREE.Vector3(0, 0, 1),
              impulse: new THREE.Vector3(0, 0, 1) });
            creationMs.push(performance.now() - before);
          }
          complexity.push({ triangles: subdivisions * subdivisions * 2, creationMs });
          owner.destroy(); wall.geometry.dispose();
        }
        wall.geometry = originalGeometry;
        timer.dispose(); prototype.begin = begin;
        return { rows, growth, complexity, errors: window.laser.errors };
      }, `/@fs${path.resolve('benchmarks/lib/passTimer.js')}`);
      await writeFile('/tmp/heat-laser-decals.json', JSON.stringify(result, null, 2));
      const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
      console.log('Decal scale:', JSON.stringify(result.rows.map(row => ({ pattern: row.pattern,
        countPerLayer: row.countPerLayer, batches: row.batches.map(batch => batch.batchCount),
        creationMs: row.creationMs, updateMs: median(row.updates), query10Ms: median(row.queryTimes),
        GPUms: median(row.samples.map(sample => sample.totalGPUms)),
        hiddenGPUms: median(row.hidden.map(sample => sample.totalGPUms)) }))));
      assert.deepEqual(errors, []); assert.deepEqual(result.errors, []);
      assert(result.rows.every(row => row.live.every(count => count === row.countPerLayer)));
      assert(result.rows.every(row => row.batches.every(batch => batch.batchCount === 1)));
    } finally { await browser?.close(); await server.close(); }
  });
