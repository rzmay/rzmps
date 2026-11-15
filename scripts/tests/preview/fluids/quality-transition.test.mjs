import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../site/dev.mjs';
import { openFixture } from './openFixture.mjs';

test('quality preparation preserves live fields and coarsening conserves scalars and MAC faces',
  { timeout: 90000 }, async () => {
    const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
    await site.demo.watcher.close();
    let browser;
    try {
      browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      const fixture = path.resolve(import.meta.dirname, 'fixtures/corrective.html');
      await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}`
        + '?reserve=64&maximum=64', errors);
      const result = await page.evaluate(async () => {
        await window.testPreparation(); await window.testProjection('Iterative');
        const { gas, renderer, tsl } = window.debugBehavior;
        const { Fn, vec3, vec4 } = tsl;
        const device = renderer.backend.device, fence = () => device.queue.onSubmittedWorkDone();
        const read = async field => new Float32Array(await renderer.getArrayBufferAsync(field.value));
        const oldCell = gas.cellSize;
        renderer.compute(gas.computeCells(index => {
          const c = gas.cellCoordinate(index), density = tsl.float(c.x).add(2);
          gas.densityCurrent.element(index).assign(vec4(density, density.mul(0.4), 0, 0));
          gas.colorCurrent.element(index).assign(vec4(vec3(0.2, 0.4, 0.8).mul(density), 0));
          gas.velocityCurrent.element(index).assign(
            vec4(vec3(c.x.add(c.y), c.y.add(c.z), c.z.add(c.x)).mul(oldCell), 0));
        }));
        const before = await read(gas.densityCurrent), textures = [gas.densityTexture, gas.colorTexture];
        const attributes = [...gas.fieldAttributes];
        const domain = { bounds: gas.bounds.clone(), gridDimensions: gas.gridDimensions.clone().divideScalar(2),
          cellSize: oldCell * 2 };
        let pipelines = 0;
        const create = device.createComputePipelineAsync.bind(device);
        device.createComputePipelineAsync = (...args) => { pipelines++; return create(...args); };
        const start = performance.now();
        const first = gas.prepareQualityChange(domain, renderer);
        let turns = 0;
        while (!gas.qualityPreparation.ready) {
          await new Promise(resolve => setTimeout(resolve, 1)); turns++;
          if (performance.now() - start > 15000) throw new Error('Quality preparation timeout');
        }
        if (gas.qualityPreparation.error) throw gas.qualityPreparation.error;
        const preparationMs = performance.now() - start, preparedPipelines = pipelines;
        const after = await read(gas.densityCurrent);
        const preparedPressure = gas.qualityPreparation.pressure;
        // A growing plume may request another destination while a pressure template is preparing.
        // Retarget only transfer stencils, retaining the same pressure program/storage owner.
        gas.prepareQualityChange({ ...domain, cellSize: oldCell * 4,
          gridDimensions: domain.gridDimensions.clone().divideScalar(2) }, renderer);
        await gas.qualityPreparation.completion;
        const retainedAfterRetarget = gas.qualityPreparation.pressure === preparedPressure;
        gas.prepareQualityChange(domain, renderer);
        await gas.qualityPreparation.completion;
        const retargetKeptPressure = retainedAfterRetarget && gas.qualityPreparation.pressure === preparedPressure;
        const grid = gas.spatialGrid;
        grid.setOptions({ volumeQuality: domain.cellSize * grid.cellsPerAxis, autoVolumeQuality: false });
        gas.bounds.copy(grid.bounds); gas.boundsMinNode.value.copy(grid.bounds.min);
        pipelines = 0; const commitStart = performance.now();
        gas.ensureGridResolution(renderer, grid);
        const commitMs = performance.now() - commitStart, commitPipelines = pipelines;
        const live = gas.volumeGrid;
        renderer.compute(Fn(() => {
          // Every new logical page is admitted into the existing resident pool for this deterministic fixture.
          live.pages.element(tsl.uint(0)).assign(1);
        })().compute(1));
        for (let page = 0; page < live.brickCount; page++) renderer.compute(Fn(() => {
          live.pages.element(page).assign(page + 1); live.slots.element(page).assign(page + 1);
        })().compute(1));
        live.updateDispatch(renderer);
        const remapPipelines = pipelines;
        const remapStart = performance.now(); gas.remapFields(renderer); await fence();
        const remapFencedMs = performance.now() - remapStart;
        const density = await read(gas.densityCurrent), color = await read(gas.colorCurrent);
        const velocity = await read(gas.velocityCurrent);
        let oldMass = 0, newMass = 0;
        for (let i = 0; i < before.length; i += 4) oldMass += before[i] * oldCell ** 3;
        for (let i = 0; i < live.brickCount * live.cellsPerBrick * 4; i += 4) {
          newMass += density[i] * (oldCell * 2) ** 3;
        }
        const result = { first, turns, preparationMs, preparedPipelines, commitMs, remapFencedMs, commitPipelines,
          retargetKeptPressure,
          remapNewPipelines: pipelines - remapPipelines,
          adopted: gas.pressureProjection === preparedPressure,
          texturesRetained: textures[0] === gas.densityTexture && textures[1] === gas.colorTexture,
          fieldsRetained: attributes.every((attribute, i) => attribute === gas.fieldAttributes[i]),
          exactLiveFields: before.every((value, i) => value === after[i]),
          density: [...density.slice(0, 4)], color: [...color.slice(0, 4)], velocity: [...velocity.slice(0, 4)],
          expectedFace: oldCell * 0.5, oldMass, newMass };
        // Refine back and check a linear interior field at the staggered face locations.
        const refinedDomain = { bounds: gas.bounds.clone(),
          gridDimensions: gas.gridDimensions.clone().multiplyScalar(2),
          cellSize: oldCell };
        gas.prepareQualityChange(refinedDomain, renderer);
        while (!gas.qualityPreparation.ready) await new Promise(resolve => setTimeout(resolve, 1));
        if (gas.qualityPreparation.error) throw gas.qualityPreparation.error;
        grid.setOptions({ volumeQuality: oldCell * grid.cellsPerAxis, autoVolumeQuality: false });
        gas.ensureGridResolution(renderer, grid);
        const refinedGrid = gas.volumeGrid;
        for (let page = 0; page < refinedGrid.brickCount; page++) renderer.compute(Fn(() => {
          refinedGrid.pages.element(page).assign(page + 1); refinedGrid.slots.element(page).assign(page + 1);
        })().compute(1));
        refinedGrid.updateDispatch(renderer); gas.remapFields(renderer); await fence();
        const refinedDensity = await read(gas.densityCurrent), refinedVelocity = await read(gas.velocityCurrent);
        // World cell (4,4,4), brick (1,1,1), local (0,0,0).
        const address = 21 * refinedGrid.cellsPerBrick * 4;
        result.refined = { density: refinedDensity[address],
          velocity: [...refinedVelocity.slice(address, address + 3)] };
        device.createComputePipelineAsync = create;
        return result;
      });
      await fs.writeFile('/tmp/quality-transition.json', JSON.stringify(result, null, 2));
      assert.equal(result.first, false);
      assert(result.turns > 1 && result.preparedPipelines > 0);
      assert.equal(result.commitPipelines, 0);
      assert.equal(result.remapNewPipelines, 0);
      assert(result.retargetKeptPressure, 'destination tier changes reuse the prepared pressure solver');
      assert(result.adopted && result.texturesRetained && result.fieldsRetained && result.exactLiveFields);
      assert(Math.abs(result.density[0] - 2.5) < 1e-5);
      assert(Math.abs(result.density[1] - 1) < 1e-5);
      assert(Math.abs(result.color[0] - 0.5) < 1e-5);
      for (const value of result.velocity.slice(0, 3)) assert(Math.abs(value - result.expectedFace) < 1e-5);
      assert(Math.abs(result.oldMass - result.newMass) < 1e-4, 'coarsening preserves integrated density');
      assert(Math.abs(result.refined.density - 6) < 1e-4, 'refinement reproduces linear interior density');
      assert(result.refined.velocity.every(value => Math.abs(value - 1) < 1e-4),
        'refinement samples the actual MAC face positions');
      assert.deepEqual(errors, []);
    } finally { await browser?.close(); await site.close(); }
  });
