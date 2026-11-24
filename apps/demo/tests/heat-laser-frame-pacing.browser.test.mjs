import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import test from 'node:test';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import { browserLaunchOptions } from '../../../scripts/browser/launch.utils.mjs';
import { openFixture } from './fluids/openFixture.mjs';

test('unthrottled heat laser records real-RAF tails, source latency and GPU completion lag',
  { timeout: 120000 }, async () => {
    const server = await createServer({ root: path.resolve(import.meta.dirname, '..'),
      server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
    let browser;
    try {
      await server.listen(); await server.watcher.close();
      browser = await puppeteer.launch(browserLaunchOptions('test'));
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const trace = process.env.RZMPS_HEAT_LASER_PREPARATION_TRACE === '1';
      if (trace) page.on('console', message => console.log(message.text()));
      await openFixture(page, `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/heatLaser.html`
        + (trace ? '?tracePreparation' : ''), errors, { timeout: 15000 });
      const result = await page.evaluate(async ({ timerURL, moving }) => {
        const { passTimer } = await import(timerURL);
        const { system, renderer, scene, camera, lifecycle } = window.laser;
        renderer.setRenderTarget(null); renderer.setSize(1280, 800);
        camera.aspect = 1280 / 800; camera.updateProjectionMatrix();
        if (moving) lifecycle.gui({ addFolder() { return this; }, add(object, key) {
          if (key === 'automaticMotion') object[key] = true;
          return { onChange(callback) { if (key === 'automaticMotion') callback(); } };
        } });
        const demo = system.userData.heatLaser, children = [...system.subSystems.keys()];
        const fumes = children.find(child => child.name === 'Laser Fire and Smoke');
        const renderGas = demo.gas.renderGPU.bind(demo.gas);
        demo.gas.renderGPU = (...args) => demo.gas.benchmarks.span('renderSourceReconstruction',
          () => renderGas(...args));
        const records = new Map(), frames = [], timings = [], timingErrors = [], completions = [], pending = [];
        const owners = new Map();
        for (const owner of [system, ...children]) {
          owners.set(owner.benchmarks, owner.name);
          owners.set(owner.gpuSimulation.benchmarks, `${owner.name}/GPU`);
          for (const component of [...owner.modules, ...owner.renderers, ...owner.emitters])
            owners.set(component.benchmarks, `${owner.name}/${component.constructor.name}`);
        }
        let stage = 'unscoped', current, frame = 0;
        const prototype = Object.getPrototypeOf(system.benchmarks), originalBegin = prototype.begin;
        prototype.begin = function (name) {
          const previous = stage, label = `${owners.get(this) ?? 'other'}/${name}`;
          stage = label;
          const started = performance.now(), finish = originalBegin.call(this, name);
          return () => {
            const duration = performance.now() - started;
            if (duration > 5 && current) current.slowScopes.push({ label, duration });
            stage = previous; finish?.();
          };
        };
        const timer = renderer.backend.device.features.has('timestamp-query')
          ? passTimer(renderer.backend.device, renderer.backend, () => stage, { slots: 4 }) : null;
        const register = system.registerEmissionSource.bind(system);
        system.registerEmissionSource = data => {
          const source = register(data);
          if (source.tags?.includes('laser-burn')) records.set(source.id, { created: performance.now(), frame });
          return source;
        };
        const bind = fumes.bindParticleSource.bind(fumes);
        fumes.bindParticleSource = (particle, source) => {
          bind(particle, source);
          const record = records.get(source?.id);
          if (record && !record.birth) record.birth = performance.now();
        };
        system.benchmarks.start({ maxSamples: 2048 });
        system.start(false);
        const started = performance.now();
        let previous = started, lastProbe = started, lastCompletion = started;
        let previousPipelines = window.laser.pipelineBuilds();
        while (performance.now() - started < 16000) {
          await new Promise(requestAnimationFrame);
          const now = performance.now();
          current = { frame, elapsed: now - started, interval: now - previous, slowScopes: [] };
          lifecycle.update((now - previous) / 1000);
          previous = now;
          const before = window.laser.pipelineBuilds();
          current.backgroundPipelines = before - previousPipelines;
          const timed = frame % 20 === 0 && timer?.start();
          let submission = performance.now();
          system.update();
          current.updateMs = performance.now() - submission;
          submission = performance.now(); stage = 'scene rendering';
          await renderer.renderAsync(scene, camera); stage = 'unscoped';
          current.renderMs = performance.now() - submission;
          current.newPipelines = window.laser.pipelineBuilds() - before;
          current.pipelineFamilies = window.laser.pipelineLabels().slice(before);
          previousPipelines = window.laser.pipelineBuilds();
          current.gpuParticles = fumes.liveParticleCount;
          current.allocatedSlots = fumes.gpuBufferStats.allocated;
          current.populationEstimate = fumes.estimateParticleCount();
          current.packetCapacity = fumes.gpuSimulation._stagedBirthBuffers?.capacity ?? 0;
          current.preparation = fumes.gpuSimulation.particleCapacity ? {
            ...fumes.gpuSimulation.particleCapacity.status, ...fumes.gpuSimulation.particleCapacity.metrics } : null;
          current.allocation = fumes.gpuAllocationStats;
          current.residentCapacity = demo.gas.volumeGrid.capacity;
          current.cpuParticles = [system, ...children.filter(child => child !== fumes)]
            .reduce((sum, owner) => sum + owner.liveParticleCount, 0);
          current.decals = demo.burns.count;
          current.residentBricks = demo.gas.brickDiagnostics.resident;
          current.cellWidth = demo.gas.cellSize;
          const backend = demo.gas.particleCollisionBackend;
          if (backend?.benchmarks) owners.set(backend.benchmarks, 'Gas collider BVH');
          current.colliderBVH = { ...backend?.stats };
          current.colliderBakes = demo.gas.fluidColliders.map(collider => collider.gpuField?.texture?.uuid);
          for (const owner of [system, ...children]) for (const module of owner.modules) {
            if (module.backend?.benchmarks) owners.set(module.backend.benchmarks,
              `${owner.name}/${module.backend.constructor.name}`);
          }
          current.completionAgeMs = performance.now() - lastCompletion;
          if (timed) {
            const sampled = frame;
            pending.push(timer.finish().then(gpu => timings.push({ frame: sampled, gpu }))
              .catch(error => timingErrors.push({ frame: sampled, message: error.message })));
          }
          if (now - lastProbe >= 500) {
            lastProbe = now;
            const sampled = frame, submitted = performance.now();
            pending.push(renderer.backend.device.queue.onSubmittedWorkDone().then(() => {
              lastCompletion = performance.now();
              completions.push({ frame: sampled, lagMs: lastCompletion - submitted });
            }));
          }
          frames.push(current); current = undefined; frame++;
        }
        await Promise.all(pending);
        const report = system.benchmarks.stop();
        timer?.dispose(); prototype.begin = originalBegin;
        return { frames, timings, timingErrors, completions, report, preparationMs: window.laser.preparationMs,
          sourceLatency: [...records.entries()].map(([id, record]) => ({ id, ...record,
            latencyMs: record.birth ? record.birth - record.created : null })), errors: window.laser.errors };
      }, { timerURL: `/@fs${path.resolve('benchmarks/lib/passTimer.js')}`,
        moving: process.env.RZMPS_HEAT_LASER_MOVING === '1' });
      await writeFile(process.env.RZMPS_HEAT_LASER_TRACE ?? '/tmp/heat-laser-frame-pacing.json',
        JSON.stringify(result, null, 2));
      const distribution = values => {
        values.sort((a, b) => a - b);
        return { p50: values[Math.floor(values.length * 0.5)], p95: values[Math.floor(values.length * 0.95)],
          p99: values[Math.floor(values.length * 0.99)], max: values.at(-1) };
      };
      console.log('Real-RAF heat laser:', JSON.stringify({ frames: result.frames.length,
        intervals: distribution(result.frames.map(frame => frame.interval)),
        over90ms: result.frames.filter(frame => frame.interval >= 90).length,
        sourceLatency: distribution(result.sourceLatency.map(source => source.latencyMs).filter(v => v != null)),
        completionLag: distribution(result.completions.map(sample => sample.lagMs)) }));
      assert.deepEqual(errors, []); assert.deepEqual(result.errors, []);
      assert(result.frames.length > 30);
    } finally { await browser?.close(); await server.close(); }
  });
