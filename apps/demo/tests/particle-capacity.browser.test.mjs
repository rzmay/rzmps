import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { createServer } from 'vite';
import { browserLaunchOptions } from '../../../scripts/browser/launch.utils.mjs';
import { openFixture } from './fluids/openFixture.mjs';

test('estimated threshold prepares particle capacity without mutation, then migrates latest GPU state',
  { timeout: 90000 }, async () => {
    const server = await createServer({ root: path.resolve(import.meta.dirname, '..'),
      server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
    let browser;
    try {
      await server.listen(); await server.watcher.close();
      browser = await puppeteer.launch(browserLaunchOptions('test'));
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await openFixture(page,
        `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/particleCapacity.html`, errors);
      const result = await page.evaluate(async () => {
        const { THREE, renderer, ParticleSystem, Emitter, errors, pipelines } = window.capacityFixture;
        const emitter = new Emitter({ rate: 16, radialSpeed: 0,
          initialValues: { velocity: new THREE.Vector3(1, 0, 0), lifetime: 1, mass: 2, alpha: 0.5 } });
        const system = new ParticleSystem({ maxParticles: 1024, emitters: [emitter], gravityModifier: 0 });
        const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
        scene.add(system); await renderer.renderAsync(scene, camera);
        await system.prepare(renderer); system.start(false);
        system.advanceFrames(12, 1 / 60);
        const gpu = system.gpuSimulation, buffers = system.gpuParticleBuffers, initialCapacity = buffers.capacity;
        emitter.rate = 200; emitter.syncGPUConfiguration();
        const estimate = system.estimateParticleCount();
        gpu.updateParticleCapacity(renderer, [], []);
        const defaultState = gpu.particleCapacity.status.state;
        const compile = renderer.compileComputeAsync;
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        renderer.compileComputeAsync = async function (nodes) {
          await compile.call(this, nodes); await gate;
        };
        system.capacityGrowthThreshold = 0.5;
        gpu.updateParticleCapacity(renderer, [], []);
        await new Promise(resolve => setTimeout(resolve, 25));
        const preparingCapacity = buffers.capacity, preparingState = gpu.particleCapacity.status.state;
        system.advanceFrames(3, 1 / 60);
        const read = async () => Promise.all([buffers.attributes.floatData, buffers.attributes.uintData]
          .map(attribute => renderer.getArrayBufferAsync(attribute)));
        const before = await read();
        const populated = new Uint8Array(before[0]).some(value => value !== 0);
        release(); await gpu.particleCapacity.whenPrepared();
        renderer.compileComputeAsync = compile;
        const beforeCommitTime = system._elapsedTime;
        const beforeCommitPipelines = pipelines();
        gpu.updateParticleCapacity(renderer, [], []);
        const after = await read();
        const equal = before.every((array, i) => {
          const previous = new Uint8Array(array), next = new Uint8Array(after[i]);
          return previous.every((value, index) => value === next[index]);
        });
        const retainedIdentity = system.gpuParticleBuffers === buffers;
        const commitPipelines = pipelines() - beforeCommitPipelines;
        const afterCommitTime = system._elapsedTime;
        const capacity = buffers.capacity, metrics = { ...gpu.particleCapacity.metrics };
        const cacheKeys = Object.keys(gpu).filter(key => key.endsWith('ComputeCache'));
        const caches = Object.fromEntries(cacheKeys.map(key => [key, gpu[key]?.key]));
        const beforeStep = pipelines(); system.advanceFrames(1, 1 / 60);
        const changedCaches = cacheKeys.filter(key => caches[key] !== gpu[key]?.key)
          .map(key => ({ key, before: caches[key], after: gpu[key]?.key }));
        const firstStepPipelines = pipelines() - beforeStep;
        await renderer.backend.device.queue.onSubmittedWorkDone();
        system.destroy();
        return { initialCapacity, estimate, defaultState, preparingCapacity, preparingState, capacity,
          equal, populated, retainedIdentity, beforeCommitTime, afterCommitTime, commitPipelines, firstStepPipelines,
          changedCaches, metrics, errors };
      });
      console.log('Prepared particle growth:', JSON.stringify(result));
      assert.deepEqual(errors, []); assert.deepEqual(result.errors, []);
      assert.equal(result.initialCapacity, 256); assert.equal(result.estimate, 200);
      assert.equal(result.defaultState, 'idle'); assert.equal(result.preparingState, 'preparing');
      assert.equal(result.preparingCapacity, 256); assert.equal(result.capacity, 512);
      assert(result.populated, 'the invariant compares populated live storage');
      assert(result.equal, 'migration retains every packed field from the latest live GPU state');
      assert(result.retainedIdentity, 'capacity growth is not a clear/reset');
      assert.equal(result.beforeCommitTime, result.afterCommitTime);
      assert.equal(result.commitPipelines, 0); assert(result.firstStepPipelines <= 2);
    } finally { await browser?.close(); await server.close(); }
  });
