import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../site/dev.mjs';
import { openFixture } from './openFixture.mjs';

test('scene replacement retains live gas without recompilation or special clock rebasing',
  { timeout: 90000 }, async () => {
    const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
    await site.demo.watcher.close();
    let browser;
    try {
      browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const fixture = path.resolve(import.meta.dirname, 'fixtures/fluid.html');
      await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}`
        + '?example=volumetricSmoke', errors, { timeout: 25000 });
      const result = await page.evaluate(async () => {
        const { renderer, scene, system, flip: gas, sceneLifecycle, camera } = window.debugFluid;
        await window.runFrames(90);
        const grid = gas.volumeGrid, field = gas.densityCurrent.value;
        const measureMass = async () => {
          const current = gas.volumeGrid;
          const density = new Float32Array(await renderer.getArrayBufferAsync(gas.densityCurrent.value));
          const pages = new Uint32Array(await renderer.getArrayBufferAsync(current.pagesAttribute));
          let mass = 0;
          for (let slot = 0; slot < current.capacity; slot++) if (pages[current.directoryCapacity + slot]) {
            for (let cell = 0; cell < current.cellsPerBrick; cell++) {
              mass += density[(slot * current.cellsPerBrick + cell) * 4] * gas.cellSize ** 3;
            }
          }
          return mass;
        };
        const massBefore = await measureMass();
        const boundsBefore = [...gas.bounds.min.toArray(), ...gas.bounds.max.toArray()];
        const before = new Float32Array(await renderer.getArrayBufferAsync(field));
        const elapsed = system._elapsedTime, buffers = system.gpuSimulation._gpuBuffers;
        const oldNow = Date.now; let clock = oldNow();
        Date.now = () => clock;
        try {
          system.lastFrame = clock;
          const { retainSceneParticleRoot } = await import(
            '/@fs' + location.pathname.split('/@fs')[1]
              .replace('/scripts/tests/preview/fluids/fixtures/fluid.html', '/examples/utils/particleRoot.js'));
          const parent = system.parent, releaseRoot = retainSceneParticleRoot(scene);
          let cleanupCalls = 0;
          const cleanup = gas.cleanup;
          gas.cleanup = function (...args) { cleanupCalls++; return cleanup.apply(this, args); };
          sceneLifecycle.cleanup();
          const { default: createColors } = await import(
            '/@fs' + location.pathname.split('/@fs')[1]
              .replace('/scripts/tests/preview/fluids/fixtures/fluid.html', '/examples/scenes/colorLights.js'));
          const lifecycle = createColors(scene);
          releaseRoot();
          await Promise.resolve();
          const sameGrid = gas.volumeGrid === grid;
          const after = new Float32Array(await renderer.getArrayBufferAsync(gas.densityCurrent.value));
          const preserved = before.length === after.length && before.every((value, i) => value === after[i]);
          const steps = [], advance = system._advanceSimulationStep;
          system._advanceSimulationStep = function (...args) {
            steps.push(this.deltaTime); return advance.apply(this, args);
          };
          // Deliberately feed a loading-sized gap through the ordinary catch-up/substep path.
          clock += 3000;
          const requestedStep = gas.getSimulationTimestep(3.016);
          clock += 16; system.update();
          await renderer.renderAsync(scene, camera);
          const massAfter = await measureMass();
          const answer = { sameGrid, sameBuffers: buffers === system.gpuSimulation._gpuBuffers,
            sameParent: parent === system.parent, cleanupCalls, preserved,
            massBefore, massAfter, boundsBefore,
            boundsAfter: [...gas.bounds.min.toArray(), ...gas.bounds.max.toArray()],
            elapsedAdvance: system._elapsedTime - elapsed, steps, requestedStep, substeps: gas.maxFluidSubsteps };
          lifecycle.cleanup(); return answer;
        } finally { Date.now = oldNow; }
      });
      await fs.writeFile('/tmp/scene-switch-state.json', JSON.stringify({ result, errors }, null, 2));
      assert.deepEqual(errors, []);
      assert(result.sameGrid && result.sameBuffers && result.preserved, JSON.stringify(result));
      assert(result.sameParent && result.cleanupCalls === 0, JSON.stringify(result));
      assert(result.elapsedAdvance > 3 && result.steps.length <= result.substeps, JSON.stringify(result));
      assert(result.steps.every(step => step > 0 && step <= result.requestedStep + 1e-6),
        'ordinary catch-up still uses bounded solver steps');
      assert(result.massBefore > 0 && Number.isFinite(result.massAfter) && result.massAfter > result.massBefore * 0.5,
        'scene replacement and a loading-sized catch-up must not clear the existing cloud');
    } finally { await browser?.close(); await site.close(); }
  });
