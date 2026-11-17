import { browserLaunchOptions } from '../../../../scripts/browser/launch.utils.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../../scripts/site/dev.mjs';
import { openFixture } from './openFixture.mjs';

for (const example of ['volumetricSmoke', 'volumetricFire']) {
  test(`${example} survives staged coarsening and refinement while frames continue`,
    { timeout: 90000 }, async () => {
      const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
      await site.demo.watcher.close();
      let browser;
      try {
        browser = await puppeteer.launch(browserLaunchOptions('test', { headless: true, args: [...browserLaunchOptions('test').args, '--enable-unsafe-webgpu'] }));
        const page = await browser.newPage(), errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => {
          if (message.type() === 'error') errors.push(message.text());
        });
        const fixture = path.resolve(import.meta.dirname, 'fixtures/fluid.html');
        await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}`
          + `?example=${example}`, errors, { timeout: 25000 });
        const result = await page.evaluate(async () => {
          const { flip: gas, renderer, system, scene, camera } = window.debugFluid;
          const volume = system.renderers.find(item => item.constructor.name === 'VolumeRenderer');
          const fence = () => renderer.backend.device.queue.onSubmittedWorkDone();
          await system.prepare(renderer);
          const samples = [];
          const device = renderer.backend.device;
          const create = device.createComputePipeline.bind(device);
          const createAsync = device.createComputePipelineAsync.bind(device);
          let pipelines = 0;
          let stage = '', built = [];
          const compute = renderer.compute;
          renderer.compute = function (nodes, ...args) {
            stage = (Array.isArray(nodes) ? nodes : [nodes]).map(node => node.name || String(node.id)).join(',');
            return compute.call(this, nodes, ...args);
          };
          device.createComputePipeline = (...args) => { pipelines++; built.push(stage); return create(...args); };
          device.createComputePipelineAsync = (...args) => { pipelines++; return createAsync(...args); };
          let submissionMs = 0;
          const measureDensity = async () => {
            const grid = gas.volumeGrid;
            const density = new Float32Array(await renderer.getArrayBufferAsync(gas.densityCurrent.value));
            const pages = new Uint32Array(await renderer.getArrayBufferAsync(grid.pagesAttribute));
            let mass = 0, nonfinite = 0;
            for (let slot = 0; slot < grid.capacity; slot++) {
              if (!pages[grid.directoryCapacity + slot]) continue;
              for (let cell = 0; cell < grid.cellsPerBrick; cell++) {
                const value = density[(slot * grid.cellsPerBrick + cell) * 4];
                if (!Number.isFinite(value)) nonfinite++;
                else mass += value * gas.cellSize ** 3;
              }
            }
            return { mass, nonfinite };
          };
          const frame = async () => {
            const start = performance.now();
            system.advanceFrames(1, 1 / 60);
            submissionMs = performance.now() - start;
            await renderer.renderAsync(scene, camera);
            await fence();
            await new Promise(resolve => setTimeout(resolve, 1));
          };
          for (let i = 0; i < 8; i++) await frame();
          const baseCell = gas.cellSize;
          for (const factor of [2, 1]) {
            const cell = baseCell * factor;
            const dimensions = gas.bounds.getSize(gas.gridDimensions.clone()).divideScalar(cell).round();
            const domain = { bounds: gas.bounds.clone(), gridDimensions: dimensions, cellSize: cell };
            gas.prepareQualityChange(domain, renderer);
            const start = performance.now(); let frames = 0;
            while (!gas.qualityPreparation?.ready) {
              if (performance.now() - start > 15000) throw new Error('Live preparation timed out');
              await frame(); frames++;
            }
            if (gas.qualityPreparation.error) throw gas.qualityPreparation.error;
            const preparationPipelines = pipelines;
            const before = await measureDensity();
            const renderGraph = volume.webgpuMaterial;
            const velocitySampler = gas.getVolumeField().sampleVelocityGPU;
            gas.spatialGrid.setOptions({ autoVolumeQuality: false,
              volumeQuality: cell * gas.spatialGrid.cellsPerAxis });
            // Source support grew while preparation ran. Match the current destination exactly,
            // as the normal automatic-readiness gate does before adopting a prepared tier.
            const destination = { bounds: gas.spatialGrid.bounds.clone(),
              gridDimensions: gas.spatialGrid.gridDimensions.clone(), cellSize: gas.spatialGrid.cellSize };
            while (!gas.prepareQualityChange(destination, renderer)) {
              if (performance.now() - start > 15000) throw new Error('Destination retarget timeout');
              await renderer.renderAsync(scene, camera);
              await new Promise(resolve => setTimeout(resolve, 1));
            }
            const prepared = gas.qualityPreparation;
            const programCount = prepared.programNodes?.length ?? 0;
            pipelines = 0; built = [];
            await frame();
            const firstSubmissionMs = submissionMs, firstFramePipelines = pipelines, pipelineStages = [...built];
            const immediate = await measureDensity();
            for (let i = 0; i < 5; i++) await frame();
            samples.push({ factor, frames, cell: gas.cellSize, ...await measureDensity(), before, immediate,
              preparationPipelines, firstFramePipelines, firstSubmissionMs, programCount,
              adopted: prepared.grid === gas.volumeGrid,
              renderGraphRetained: volume.webgpuMaterial === renderGraph,
              velocitySamplerRetained: gas.getVolumeField().sampleVelocityGPU === velocitySampler,
              cacheAdopted: prepared.programs?.velocityNodes === gas.velocityNodes,
              sourceCacheAdopted: prepared.programs?.sourceNodes === gas.sourceNodes,
              visualCacheAdopted: prepared.programs?.visualSourceNode === gas.visualSourceNode,
              pipelineStages,
              version: gas.getVolumeField().version });
          }
          // Resume ordinary adaptive growth after forced transfers, including asynchronous support reads.
          gas.spatialGrid.setOptions({ autoVolumeQuality: true });
          for (let i = 0; i < 180; i++) {
            await frame();
            if (i % 30 === 29) samples.push({ sustained: i + 1, cell: gas.cellSize, ...await measureDensity() });
          }
          device.createComputePipeline = create; device.createComputePipelineAsync = createAsync;
          renderer.compute = compute;
          return samples;
        });
        await fs.writeFile(`/tmp/quality-transition-live-${example}.json`, JSON.stringify({ result, errors }, null, 2));
        assert.deepEqual(errors, []);
        assert(result.every(sample => sample.nonfinite === 0 && sample.mass > 0));
        const transfers = result.filter(sample => sample.factor);
        assert(transfers.every(sample => sample.frames > 0 && sample.immediate.mass > sample.before.mass * 0.5),
          'a tier change must not discard most of the live gas in one frame');
        assert.equal(result[0].cell / result[1].cell, 2);
        assert(transfers.every(sample => sample.renderGraphRetained && sample.velocitySamplerRetained),
          'quality changes must rebind render velocity without rebuilding or retaining retired pressure bindings');
        assert(transfers.every(sample => sample.adopted && sample.cacheAdopted
          && sample.sourceCacheAdopted && sample.visualCacheAdopted));
        assert(transfers.every(sample => sample.pipelineStages.every(stage => !stage.includes('rzmps.grid.'))),
          'runtime directory quality edits must retain spatial-index programs');
        assert(transfers.every(sample => sample.firstFramePipelines < 25), 'adoption rebuilt the transport bundle');
      } finally { await browser?.close(); await site.close(); }
    });
}
