import { browserLaunchOptions } from '../../../../scripts/browser/launch.utils.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../../scripts/site/dev.mjs';
import { openFixture } from './openFixture.mjs';

test('exported velocity filters cells and survives directory, texture and reset replacement',
  { timeout: 60000 }, async () => {
    const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
    await site.demo.watcher.close();
    let browser;
    try {
      browser = await puppeteer.launch(browserLaunchOptions('test', { headless: true, args: [...browserLaunchOptions('test').args, '--enable-unsafe-webgpu'] }));
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      const base = `http://127.0.0.1:${site.demo.httpServer.address().port}`;
      await openFixture(page, `${base}/@fs${path.resolve(import.meta.dirname, 'fixtures/corrective.html')}`, errors);
      const result = await page.evaluate(async () => {
        const { gas, renderer, system, THREE, StorageBufferAttribute, tsl } = window.debugBehavior;
        const { Fn, storage, vec3, vec4, instanceIndex, uniform } = tsl;
        const grid = gas.volumeGrid, b = grid.brickSide;
        // Reverse physical slot order; the continuous field must still interpolate across the brick face.
        renderer.compute(Fn(() => grid.pages.element(instanceIndex).assign(0))().compute(grid.brickCount));
        renderer.compute(Fn(() => {
          grid.pages.element(0).assign(2); grid.pages.element(1).assign(1);
          grid.slots.element(0).assign(2); grid.slots.element(1).assign(1);
        })().compute(1));
        renderer.compute(Fn(() => {
          const c = grid.coordinate(instanceIndex);
          gas.velocityCurrent.element(instanceIndex).assign(vec4(vec3(c), 0));
          gas.faceOpenness.element(instanceIndex).assign(vec4(1));
        })().compute(2 * grid.cellsPerBrick));
        grid.updateDispatch(renderer);
        gas.clearOutputTextures(renderer);
        renderer.compute(gas.createOutputNode(gas.densityCurrent, gas.colorCurrent));
        const point = uniform(new THREE.Vector3());
        const output = new StorageBufferAttribute(new Float32Array(4), 4);
        const target = storage(output, 'vec4', 1);
        const sampler = gas.getVolumeField().sampleVelocityGPU;
        const probe = Fn(() => target.element(0).assign(vec4(sampler(point), 0)))().compute(1);
        const read = async coordinate => {
          point.value.copy(coordinate);
          renderer.compute(probe);
          return [...new Float32Array(await renderer.getArrayBufferAsync(output))].slice(0, 3);
        };
        const center = (x, y, z) => new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5)
          .multiplyScalar(gas.cellSize).add(gas.bounds.min);
        const interior = await read(center(1.5, 1.5, 1.5));
        const exact = await read(center(b - 1, 1, 1));
        const interpolated = await read(center(b - 0.5, 1, 1));
        const missing = await read(center(0, b + 1, 0));
        const outside = await read(center(-2, 0, 0));
        const binding = gas.velocityTextureSampler;

        // Different brick size, capacity, spacing, and rectangle with a page beyond the old capacity.
        // The already-compiled sampler must stop referencing the old directory even after disposal.
        const next = new grid.constructor({ brickSubdivisions: 2, cellSubdivisions: 1,
          bounds: new THREE.Box3(new THREE.Vector3(-2, -1, 0), new THREE.Vector3(2, 1, 2)) },
        8, new THREE.Vector3(8, 4, 4));
        const attribute = new StorageBufferAttribute(new Float32Array(next.cellCount * 4), 4);
        const values = storage(attribute, 'vec4', next.cellCount);
        renderer.compute(Fn(() => {
          next.pages.element(1).assign(7); next.slots.element(6).assign(2);
        })().compute(1));
        renderer.compute(Fn(() => {
          const index = instanceIndex.add(6 * next.cellsPerBrick);
          values.element(index).assign(vec4(-4, 5, -6, 0));
          gas.faceOpenness.element(index).assign(vec4(1));
        })().compute(next.cellsPerBrick));
        gas.volumeGrid = next; gas.velocityCurrentAttribute = attribute; gas.velocityCurrent = values;
        gas.bounds.copy(next.bounds); gas.gridDimensions.copy(next.gridDimensions); gas.cellSize = next.cellSize;
        gas.boundsMinNode.value.copy(next.bounds.min); gas.dimensionsNode.value.copy(next.gridDimensions);
        gas.cellSizeNode.value = next.cellSize;
        next.updateDispatch(renderer);
        gas.updateExportLayout(renderer);
        const exportNode = gas.createOutputNode(gas.densityCurrent, gas.colorCurrent);
        gas.clearOutputTextures(renderer); renderer.compute(exportNode);
        grid.dispose(renderer);
        let pipelines = 0;
        const device = renderer.backend.device;
        const create = device.createComputePipeline.bind(device);
        device.createComputePipeline = (...args) => { pipelines++; return create(...args); };
        const replaced = await read(new THREE.Vector3(2.5, 0.5, 0.5)
          .multiplyScalar(next.cellSize).add(next.bounds.min));
        device.createComputePipeline = create;
        const sameBinding = binding === gas.velocityTextureSampler;
        const oldTexture = gas.velocityTexture;
        let disposed = false;
        oldTexture.addEventListener('dispose', () => { disposed = true; });
        const demand = gas.textureDimensions.clone().multiplyScalar(2);
        gas.ensureTextureCapacity(renderer, demand);
        await gas.textureAllocation.whenPrepared();
        gas.ensureTextureCapacity(renderer, demand);
        gas.clearOutputTextures(renderer); renderer.compute(exportNode);
        const grown = await read(point.value.clone());
        await renderer.backend.device.queue.onSubmittedWorkDone();
        await new Promise(resolve => setTimeout(resolve, 0));
        const textureReplaced = gas.velocityTexture !== oldTexture
          && binding.value === gas.velocityTexture && disposed;
        // Transient gas effects alter only exported velocity, not the persistent solver field.
        gas.transientEffects = [{}];
        renderer.compute(Fn(() => {
          const index = instanceIndex.add(6 * next.cellsPerBrick);
          gas.visualDensity.element(index).assign(vec4(1, 0.5, 7, -8));
          gas.visualColor.element(index).assign(vec4(0.25, 0.5, 0.75, 9));
        })().compute(next.cellsPerBrick));
        renderer.compute(gas.createVisualOutputNode(gas.densityCurrent, gas.colorCurrent));
        const transient = await read(point.value.clone());
        const persistentValues = new Float32Array(await renderer.getArrayBufferAsync(attribute));
        const persistent = [...persistentValues.slice(48 * 4, 48 * 4 + 3)];
        // A released brick must not leave a stale vector in the dense export.
        renderer.compute(Fn(() => {
          next.pages.element(1).assign(0); next.slots.element(6).assign(0);
        })().compute(1));
        next.updateDispatch(renderer);
        gas.clearOutputTextures(renderer); renderer.compute(exportNode);
        const released = await read(point.value.clone());
        gas.getParticleSpatialGrid(system);
        gas.onParticleStateReset();
        const reset = await read(point.value.clone());
        const resetBindingRetained = binding === gas.velocityTextureSampler;
        probe.dispose(); output.dispose();
        return { interior, exact, interpolated, missing, outside, replaced, grown, released,
          textureReplaced, transient, persistent, reset, resetBindingRetained, pipelines, sameBinding, b };
      });
      assert.deepEqual(errors, []);
      assert.deepEqual(result.interior, [1.5, 1.5, 1.5]);
      assert.deepEqual(result.exact, [result.b - 1, 1, 1]);
      assert.deepEqual(result.interpolated, [result.b - 0.5, 1, 1]);
      assert.deepEqual(result.missing, [0, 0, 0]);
      assert.deepEqual(result.outside, [0, 0, 0]);
      assert.deepEqual(result.replaced, [-4, 5, -6]);
      assert.deepEqual(result.grown, [-4, 5, -6]);
      assert.deepEqual(result.released, [0, 0, 0]);
      assert.deepEqual(result.transient, [7, -8, 9]);
      assert.deepEqual(result.persistent, [-4, 5, -6]);
      assert.deepEqual(result.reset, [0, 0, 0]);
      assert(result.resetBindingRetained);
      assert(result.textureReplaced, 'sampled and storage texture bindings must swap and retire together');
      assert.equal(result.pipelines, 0);
      assert(result.sameBinding);
    } finally { await browser?.close(); await site.close(); }
  });
