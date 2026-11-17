import { browserLaunchOptions } from '../../../../scripts/browser/launch.utils.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../../scripts/site/dev.mjs';
import { openFixture } from './openFixture.mjs';

test('gas cell rules compose coefficients and render transient samples without rebuilding storage',
  { timeout: 120000 }, async () => {
    const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
    await site.demo.watcher.close();
    let browser;
    try {
      browser = await puppeteer.launch(browserLaunchOptions('test', { headless: true, args: [...browserLaunchOptions('test').args, '--enable-unsafe-webgpu'] }));
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
          const above = context.grid.getCell(context.index.x, context.index.y.add(1), context.index.z);
          cell.temperature.addAssign(above.temperature.mul(0.1));
          cell.color.addAssign(above.color.mul(0.1));
          cell.velocity.addAssign(above.velocity.mul(0.01));
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

      const neighborhood = await page.evaluate(async () => {
        const { gas, renderer, system, GasModule, StorageBufferAttribute, tsl } = window.debugBehavior;
        const { Fn, storage, vec3, vec4, float, instanceIndex } = tsl;
        for (const module of system.getModules(GasModule)) system.removeModule(module);
        const grid = gas.volumeGrid, side = grid.brickSide;
        // Reverse the two physical slots: logical neighbors must not follow packed slot order.
        renderer.compute(Fn(() => grid.pages.element(instanceIndex).assign(0))().compute(grid.brickCount));
        renderer.compute(Fn(() => grid.slots.element(instanceIndex).assign(0))().compute(grid.capacity));
        renderer.compute(Fn(() => {
          grid.pages.element(0).assign(2); grid.slots.element(1).assign(1);
          grid.pages.element(1).assign(1); grid.slots.element(0).assign(2);
        })().compute(1));
        grid.updateDispatch(renderer);
        renderer.compute(Fn(() => {
          const c = gas.cellCoordinate(instanceIndex);
          const density = float(c.x.add(c.y.mul(2)).add(c.z.mul(3)).add(1));
          gas.densityCurrent.element(instanceIndex).assign(vec4(density, density.mul(float(c.y).add(0.5)), 0, 0));
          gas.colorCurrent.element(instanceIndex).assign(vec4(vec3(0.2, 0.4, 0.6).mul(density), 0));
          gas.velocityCurrent.element(instanceIndex).assign(vec4(vec3(c), 0));
        })().compute(2 * grid.cellsPerBrick));
        // Poison the sentinel to prove missing cells are explicitly reconstructed as zero.
        renderer.compute(Fn(() => {
          const sentinel = grid.getCellCountNode().sub(1);
          for (const field of [gas.densityCurrent, gas.colorCurrent, gas.velocityCurrent])
            field.element(sentinel).assign(vec4(999));
        })().compute(1));
        const output = new StorageBufferAttribute(new Float32Array(48), 4);
        const target = storage(output, 'vec4', 12);
        const query = gas.createGasGridQuery(gas.densityCurrent, gas.colorCurrent, gas.velocityCurrent);
        renderer.compute(Fn(() => {
          const coordinates = [[side - 1, 2, 1], [side, 1, 1], [0, side, 0],
            [-1, 0, 0], [0, -1, 0], [0, 0, -1],
            [gas.gridDimensions.x, 0, 0], [0, gas.gridDimensions.y, 0], [0, 0, gas.gridDimensions.z]];
          for (const [i, [x, y, z]] of coordinates.entries()) {
            const cell = query.getCell(float(x), float(y), float(z));
            target.element(i).assign(vec4(cell.density, cell.temperature, cell.velocity.x, cell.color.x));
          }
          const neighbor = query.getCell(float(side), float(1), float(1));
          target.element(9).assign(vec4(neighbor.velocity, neighbor.color.z));
          target.element(10).assign(vec4(neighbor.position, 0));
          // Mutating a returned expression is shader-local, never a write to its producer buffer.
          neighbor.density.assign(777);
          target.element(11).assign(vec4(query.getCell(float(side), float(1), float(1)).density, 0, 0, 0));
        })().compute(1));
        const samples = [...new Float32Array(await renderer.getArrayBufferAsync(output))];
        const first = new GasModule({ priority: -1, modifyGPU(cell) { cell.density.addAssign(100); } });
        const second = new GasModule({ priority: 1, modifyGPU(cell, context) {
          const { x, y, z } = context.index;
          cell.density.addAssign(context.grid.getCell(x.sub(1), y, z).density);
          cell.temperature.assign(context.grid.getCell(x, y, z).density);
        } });
        system.addModule(second); system.addModule(first);
        gas.prepareGasEffects(system);
        renderer.compute(Fn(() => {
          const coordinate = gas.cellCoordinate(instanceIndex);
          const result = gas.evaluateGasModules(gas.densityCurrent.element(instanceIndex),
            gas.colorCurrent.element(instanceIndex), gas.velocityCurrent.element(instanceIndex).xyz,
            gas.cellCenter(coordinate), { deltaTimeNode: float(0.1), elapsedTimeNode: float(2) });
          gas.densityNext.element(instanceIndex).assign(vec4(result.cell.density, result.cell.temperature, 0, 0));
        })().compute(2 * grid.cellsPerBrick));
        const result = new Float32Array(await renderer.getArrayBufferAsync(gas.densityNext.value));
        const before = new Float32Array(await renderer.getArrayBufferAsync(gas.densityCurrent.value));
        let maximumError = 0;
        for (let slot = 0; slot < 2; slot++) for (let local = 0; local < grid.cellsPerBrick; local++) {
          const x = (slot === 0 ? side : 0) + local % side;
          const y = Math.floor(local / side) % side, z = Math.floor(local / (side * side));
          const own = x + 2 * y + 3 * z + 1, left = x === 0 ? 0 : own - 1;
          const address = (slot * grid.cellsPerBrick + local) * 4;
          maximumError = Math.max(maximumError, Math.abs(result[address] - (own + 100 + left)),
            Math.abs(result[address + 1] - own), Math.abs(before[address] - own));
        }
        const expectedPosition = gas.bounds.min.clone().addScalar(0.5 * gas.cellSize)
          .addScaledVector(new window.debugBehavior.THREE.Vector3(side, 1, 1), gas.cellSize).toArray();
        output.dispose();
        return { samples, maximumError, expectedPosition, side };
      });
      const { samples, side } = neighborhood;
      assert(Math.abs(samples[0] - (side + 7)) < 1e-5);
      assert.equal(samples[1], 2.5);
      assert.equal(samples[2], side - 1);
      assert(Math.abs(samples[3] - 0.2) < 1e-5);
      assert.equal(samples[4], side + 6);
      assert.equal(samples[5], 1.5);
      assert.equal(samples[6], side);
      assert(samples.slice(8, 36).every(value => value === 0), 'holes and all six domain faces return zero');
      assert.deepEqual(samples.slice(36, 39), [side, 1, 1]);
      assert(Math.abs(samples[39] - 0.6) < 1e-5);
      assert(samples.slice(40, 43).every((value, i) => Math.abs(value - neighborhood.expectedPosition[i]) < 1e-5));
      assert.equal(samples[44], side + 6, 'query expressions never write neighbor storage');
      assert.equal(neighborhood.maximumError, 0, 'fused priority edits query the unchanged input snapshot');

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
