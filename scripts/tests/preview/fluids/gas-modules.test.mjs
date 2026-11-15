import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../site/dev.mjs';
import { openFixture } from './openFixture.mjs';

test('gas cell rules compose coefficients and render transient samples without rebuilding storage',
  { timeout: 120000 }, async () => {
    const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
    await site.demo.watcher.close();
    let browser;
    try {
      browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      const origin = `http://127.0.0.1:${site.demo.httpServer.address().port}`;
      await openFixture(page, `${origin}/@fs${path.resolve(import.meta.dirname, 'fixtures/corrective.html')}`, errors);
      const simulation = await page.evaluate(async () => {
        const { GasModule, gas, system, renderer, StorageBufferAttribute, tsl } = window.debugBehavior;
        const { Fn, storage, vec3, vec4, float } = tsl;
        gas.turbulenceNoiseStrength = 2;
        gas.turbulenceNoiseStrengthByTemperature = () => 3;
        gas.densityDissipation = 0.2;
        gas.densityDissipationByDensity = () => 2;
        const a = new GasModule({ priority: -2, modifyGPU(cell, context) {
          context.turbulenceNoiseStrength.mulAssign(2);
          context.densityDissipation.addAssign(0.1);
          cell.temperature.addAssign(cell.color.x);
          cell.density.addAssign(cell.velocity.x.mul(0.01));
        } });
        const b = new GasModule({ priority: 2, modifyGPU(cell, context) {
          context.turbulenceNoiseStrength.addAssign(1);
          context.densityDissipation.mulAssign(0.5);
          cell.color.mulAssign(cell.position.y);
        } });
        const originalRule = a.modifyGasGPU;
        system.addModule(b); system.addModule(a);
        const attributes = [...gas.fieldAttributes];
        const output = new StorageBufferAttribute(new Float32Array(8), 4);
        const target = storage(output, 'vec4', 2);
        const sample = async () => {
          gas.prepareGasEffects(system); gas.syncSimulationUniforms();
          const key = gas.gasModulesKey;
          renderer.compute(Fn(() => {
            const result = gas.evaluateGasModules(vec4(0.4, 0.2, 0, 0), vec4(0.08, 0.12, 0.16, 0),
              vec3(1, 2, 3), vec3(0, 0.5, 0), { deltaTimeNode: float(0.1), elapsedTimeNode: float(2) });
            target.element(0).assign(vec4(result.coefficients.turbulenceNoiseStrength,
              result.coefficients.densityDissipation, result.cell.density, result.cell.temperature));
            target.element(1).assign(vec4(result.cell.color, 0));
          })().compute(1));
          return { values: [...new Float32Array(await renderer.getArrayBufferAsync(output))], key };
        };
        const composed = await sample();
        a.enabled = false;
        const disabled = await sample();
        a.enabled = true;
        a.modifyGasGPU = (cell, context) => context.turbulenceNoiseStrength.mulAssign(4);
        const changed = await sample();
        const sameStorage = attributes.every((attribute, i) => attribute === gas.fieldAttributes[i]);
        a.modifyGasGPU = originalRule;
        a.modifyGPU = () => { throw new Error('GasModule executed as a GPU particle modifier'); };
        // Bring the renderer online before advancing, matching normal application ownership.
        await renderer.renderAsync(window.debugBehavior.scene, window.debugBehavior.camera);
        const checks = [];
        const originalSpan = gas.benchmarks.span.bind(gas.benchmarks);
        gas.benchmarks.span = (name, callback) => {
          renderer.backend.device.pushErrorScope('validation');
          try { return originalSpan(name, callback); }
          finally {
            checks.push(renderer.backend.device.popErrorScope().then(error => {
              if (error) throw new Error(`${name}: ${error.message}`);
            }));
          }
        };
        // Exercise the actual transport/vorticity graphs, including both advection methods.
        system.advanceFrames(1, 1 / 60);
        await renderer.backend.device.queue.onSubmittedWorkDone();
        gas.advectionMethod = 'MacCormack';
        system.advanceFrames(1, 1 / 60);
        await renderer.backend.device.queue.onSubmittedWorkDone();
        await Promise.all(checks);
        output.dispose();
        return { composed, disabled, changed, sameStorage };
      });
      assert(Math.abs(simulation.composed.values[0] - 13) < 1e-5);
      assert(Math.abs(simulation.composed.values[1] - 0.25) < 1e-5);
      assert(Math.abs(simulation.composed.values[2] - 0.41) < 1e-5);
      assert(Math.abs(simulation.composed.values[3] - 0.7) < 1e-5);
      assert(Math.abs(simulation.composed.values[4] - 0.1) < 1e-5);
      assert(Math.abs(simulation.disabled.values[0] - 7) < 1e-5);
      assert(Math.abs(simulation.changed.values[0] - 25) < 1e-5);
      assert.notEqual(simulation.composed.key, simulation.changed.key);
      assert(simulation.sameStorage, 'callback changes must not recreate persistent gas fields');

      const volumeFixture = path.resolve(import.meta.dirname, 'fixtures/volume.html');
      await openFixture(page, `${origin}/@fs${volumeFixture}?backend=webgpu`,
        errors);
      const rendering = await page.evaluate(async () => {
        const { GasModule, volume, system, red } = window.volumeFixture;
        Object.assign(volume, { dynamicResolution: false, jitter: false, densityMapping: 'Linear',
          opacity: 0.5, minDensity: 0, maxDensity: 1, densityNoiseStrength: 0 });
        const original = red.density.data.slice();
        const baseline = (await window.renderVolume(['red'])).middle[0];
        const module = new GasModule({ modifyRenderGPU(cell, context) {
          context.opacity.mulAssign(0.25);
          context.color.mulAssign(0.5);
          context.densityNoiseContrast.mulAssign(cell.density.add(1));
        } });
        system.addModule(module);
        const modified = (await window.renderVolume(['red'])).middle[0];
        const material = volume.webgpuMaterial;
        module.modifyGasGPU = (cell, context) => context.buoyancy.mulAssign(2);
        await window.renderVolume(['red']);
        const unchangedRenderGraph = material === volume.webgpuMaterial;
        module.enabled = false;
        const disabled = (await window.renderVolume(['red'])).middle[0];
        module.enabled = true;
        module.modifyRenderGPU = (cell, context) => context.opacity.assign(0);
        const changed = (await window.renderVolume(['red'])).middle[0];
        return { baseline, modified, disabled, changed, unchangedRenderGraph,
          unchanged: original.every((v, i) => v === red.density.data[i]),
          noStorage: !('fieldAttributes' in module) && volume.bindings.size === 2 };
      });
      assert(rendering.modified > 0 && rendering.modified < rendering.baseline);
      assert.equal(rendering.disabled, rendering.baseline);
      assert.equal(rendering.changed, 0);
      assert(rendering.unchangedRenderGraph, 'simulation-only callback changes preserve the render graph');
      assert(rendering.unchanged, 'render callbacks never modify source density');
      assert(rendering.noStorage, 'render callbacks add no persistent gas fields or source textures');
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await site.close();
    }
  });
