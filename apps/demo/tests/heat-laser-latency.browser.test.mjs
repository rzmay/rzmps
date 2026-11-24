import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import test from 'node:test';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import { browserLaunchOptions } from '../../../scripts/browser/launch.utils.mjs';

test('burn sources start CPU emission, GPU particles and nearby gas promptly during a sweep',
  { timeout: 90000 }, async () => {
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
      const result = await page.evaluate(async () => {
        const { system, renderer, scene, camera, THREE, StorageBufferAttribute, tsl } = window.laser;
        const demo = system.userData.heatLaser;
        const fumes = [...system.subSystems.keys()].find(child => child.name === 'Laser Fire and Smoke');
        const records = new Map(), started = performance.now();
        let frame = 0;
        const mark = () => ({ wallMs: performance.now() - started, frame });
        const register = system.registerEmissionSource.bind(system);
        system.registerEmissionSource = data => {
          const source = register(data);
          if (source.tags?.includes('laser-burn')) records.set(source.id, { source, spawn: mark() });
          return source;
        };
        const bind = fumes.bindParticleSource.bind(fumes);
        fumes.bindParticleSource = (particle, source) => {
          bind(particle, source);
          const record = records.get(source?.id);
          if (record && !record.cpu) record.cpu = mark();
        };
        const emitter = fumes.emitters[0], spawn = emitter.spawnParticle.bind(emitter);
        emitter.spawnParticle = (particles, time, context, owner) => {
          const record = records.get(context.source?.id);
          if (record && !record.attempt) record.attempt = mark();
          const particle = spawn(particles, time, context, owner);
          if (record && !particle) {
            record.rejected = (record.rejected ?? 0) + 1;
            record.rejectionState = { count: particles.length, max: owner.maxParticles,
              alive: particles.filter(particle => particle.alive).length, quality: owner.quality,
              pendingReadback: owner.gpuSimulation._gpuReadbackPending };
          }
          return particle;
        };
        const gpu = fumes.gpuSimulation, submit = gpu._computeStagedBirths.bind(gpu);
        const submissions = [];
        gpu._computeStagedBirths = context => {
          const batch = fumes.emissionRuntime._stagedBirths;
          const first = [...new Set(batch.map(particle => records.get(particle.source?.id)))]
            .filter(record => record && !record.submit);
          first.forEach(record => {
            record.submit = mark();
            record.submissionState = { batch: batch.length, slots: context.buffers.capacity,
              estimated: fumes.estimateParticleCount(), active: gpu._gpuAllocationDiagnostics?.activeCount,
              failures: gpu._gpuAllocationDiagnostics?.allocationFailures,
              preparation: gpu.particleCapacity?.status, metrics: { ...gpu.particleCapacity?.metrics } };
          });
          submit(context);
          if (first.length) submissions.push(renderer.backend.device.queue.onSubmittedWorkDone().then(() => {
            first.forEach(record => { record.submissionComplete = mark(); });
          }));
        };
        const positions = new StorageBufferAttribute(new Float32Array(256 * 4), 4);
        const samples = new StorageBufferAttribute(new Float32Array(256 * 4), 4);
        const input = tsl.storage(positions, 'vec4', 256), output = tsl.storage(samples, 'vec4', 256);
        const probes = new Map(), pending = [], capacityChanges = [];
        const frames = 480;
        for (frame = 0; frame < frames; frame++) {
          await new Promise(requestAnimationFrame);
          system.advanceFrames(1, 1 / 60);
          await renderer.renderAsync(scene, camera);
          if (frame % 6 !== 0 || !records.size) continue;
          const list = [...records.values()].slice(0, 256);
          list.forEach(({ source }, index) => {
            const position = new THREE.Vector3(0, 0.25, 0).applyMatrix4(source.transform);
            positions.array.set([...position.toArray(), 1], index * 4);
          });
          positions.needsUpdate = true;
          const field = demo.gas.densityCurrent;
          if (!probes.has(field)) probes.set(field, tsl.Fn(() => {
            output.element(tsl.instanceIndex).assign(demo.gas.sampleField(input.element(tsl.instanceIndex).xyz, field));
          })().compute(256));
          renderer.compute(probes.get(field));
          const buffers = fumes.gpuParticleBuffers;
          const observed = mark();
          const sources = [...(fumes.frameRuntime._sourceFrames?.records ?? [])];
          pending.push(Promise.all([
            renderer.getArrayBufferAsync(buffers.attributes.floatData),
            renderer.getArrayBufferAsync(buffers.attributes.uintData),
            renderer.getArrayBufferAsync(samples),
          ]).then(([floatBytes, stateBytes, sampleBytes]) => {
            const words = new Uint32Array(floatBytes), states = new Uint32Array(stateBytes);
            if (capacityChanges.at(-1)?.capacity !== buffers.capacity) {
              capacityChanges.push({ frame: observed.frame, capacity: buffers.capacity });
            }
            for (let index = 0; index < buffers.count; index++) {
              if (!states[index * 4]) continue;
              const offset = index * buffers.floatStride + 44;
              if (words[offset + 2] !== 2) continue;
              const source = sources.find(record => record.slot === words[offset]
                && record.generation === words[offset + 1])?.source;
              const record = records.get(source?.id);
              if (record && !record.gpu) {
                record.gpu = observed;
                record.gpuComplete = mark();
              }
            }
            const values = new Float32Array(sampleBytes);
            list.forEach((record, index) => {
              if (values[index * 4] > 0.001 && !record.gas) record.gas = observed;
            });
          }));
        }
        await Promise.all([...pending, ...submissions]);
        probes.forEach(node => node.dispose()); positions.dispose(); samples.dispose();
        return { capacityChanges,
          records: [...records.values()].map(({ source, ...times }) => ({ id: source.id, ...times })),
          errors: window.laser.errors };
      });
      if (process.env.RZMPS_HEAT_LASER_LATENCY_TRACE) {
        await writeFile(process.env.RZMPS_HEAT_LASER_LATENCY_TRACE, JSON.stringify(result, null, 2));
      }
      const stageNames = ['cpu', 'submit', 'submissionComplete', 'gpu', 'gas', 'gpuComplete'];
      const stages = Object.fromEntries(stageNames.map(stage => {
        const values = result.records.filter(record => record[stage])
          .map(record => record[stage].wallMs - record.spawn.wallMs).sort((a, b) => a - b);
        return [stage, { observed: values.length, p50Ms: values[Math.floor(values.length / 2)],
          p95Ms: values[Math.floor((values.length - 1) * 0.95)], maxMs: values.at(-1) }];
      }));
      console.log('Burn emission latency:', JSON.stringify({ sources: result.records.length, stages,
        rejectedBirths: result.records.reduce((sum, record) => sum + (record.rejected ?? 0), 0),
        capacityChanges: result.capacityChanges }));
      assert(result.records.length > 5, 'exercise multiple new decals during the sweep');
      assert.deepEqual(errors, []); assert.deepEqual(result.errors, []);
      const mature = result.records.filter(record => record.spawn.frame < 420);
      assert(mature.every(record => record.cpu && record.cpu.frame - record.spawn.frame <= 2));
      // Allow one occupancy-readback/growth interval in addition to the six-frame observation cadence.
      assert(mature.every(record => record.gpu && record.gpu.frame - record.spawn.frame <= 18));
      assert(mature.every(record => record.gas && record.gas.frame - record.spawn.frame <= 30));
      assert(result.capacityChanges.length > 1, 'exercise growth beyond the initial staged particle pool');
      assert(result.records.every(record => !record.rejected), 'CPU mirror occupancy must not deny staged births');
    } finally { await browser?.close(); await server.close(); }
  });
