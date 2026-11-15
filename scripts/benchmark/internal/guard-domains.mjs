/* global window, location */
// Live-domain characterization: bounds work stays enabled throughout the measured loop.
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../site/dev.mjs';
import { openFixture } from '../../tests/preview/fluids/openFixture.mjs';

const output = process.argv[2] ?? '/tmp/rzmps-guard-domains.json';
const baseline = process.argv[3];
const build = path.resolve('packages/rzmps/build/index.mjs');
const current = await fs.readFile(build);
const results = [];
try {
  if (baseline) await fs.writeFile(build, await fs.readFile(baseline));
  const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
  await site.demo.watcher.close();
  const browser = await puppeteer.launch({ headless: true, protocolTimeout: 180000,
    args: ['--enable-unsafe-webgpu'] });
  try {
    for (const example of ['volumetricSmoke', 'volumetricFire', 'flipFluid']
      .filter(example => process.env.EXAMPLES ? process.env.EXAMPLES.split(',').includes(example)
        : !process.argv[4] || example === process.argv[4])) {
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await page.evaluateOnNewDocument(() => {
        let seed = 173;
        Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
      });
      const fixture = path.resolve(import.meta.dirname, '../../tests/preview/fluids/fixtures/fluid.html');
      const query = new URLSearchParams({ example, profile: 'true', reviewGrid: '3,4',
        profileFrames: process.env.FRAMES ?? '360', measureStartup: 'true',
        ...(process.env.PREPARE === '1' ? { prepareStartup: 'true' } : {}) });
      try {
        await openFixture(page,
          `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}?${query}`,
          errors, { timeout: 120000 });
        const observation = await page.evaluate(async () => {
          const { system, flip: fluid, renderer, scene, camera, THREE } = window.debugFluid;
          const stages = {}, slowDispatches = [], transitions = [], samples = [];
          let stage = 'other', frame = -1, dispatches = [], requested;
          const pipelineEvents = [], pipeline = renderer.backend.createComputePipeline;
          renderer.backend.createComputePipeline = function (...args) {
            const start = performance.now();
            try { return pipeline.apply(this, args); } finally {
              pipelineEvents.push({ frame, stage, submissionMs: performance.now() - start });
            }
          };
          if (fluid.spatialGrid.resolveOccupiedBounds) {
            const resolve = fluid.spatialGrid.resolveOccupiedBounds;
            fluid.spatialGrid.resolveOccupiedBounds = function (...args) {
              const bounds = resolve.apply(this, args);
              if (!bounds.equals(fluid.bounds)) requested = { wall: performance.now(), time: system._elapsedTime };
              return bounds;
            };
          }
          const span = fluid.benchmarks.span;
          fluid.benchmarks.span = function (name, callback) {
            const previous = stage, started = performance.now(); stage = name;
            try { return span.call(this, name, callback); } finally {
              stages[`span:${name}`] = (stages[`span:${name}`] ?? 0) + performance.now() - started;
              stage = previous;
            }
          };
          for (const method of ['ensureGridResolution', 'computeTransport', 'solveProjection', 'remapFields',
            'refreshBounds', 'readOccupiedFieldBounds', 'reduceFieldMaxima',
            'computeSolidField', 'renderGPU']) {
            const original = fluid[method];
            if (!original) continue;
            fluid[method] = function (...args) {
              const previous = stage, start = performance.now(); stage = method;
              try { return original.apply(this, args); } finally {
                stages[method] = (stages[method] ?? 0) + performance.now() - start;
                stage = previous;
              }
            };
          }
          const compute = renderer.compute;
          renderer.compute = function (nodes, ...args) {
            const start = performance.now(), result = compute.call(this, nodes, ...args);
            const cpuMs = performance.now() - start;
            const name = Array.isArray(nodes) ? nodes.map(node => node.name).join(',') : nodes.name;
            const measuredStage = name?.includes('rendererOccupancy') ? 'rendererOccupancy'
              : name?.includes('rzmps.guard.') ? 'guardPrediction'
                : name?.includes('rzmps.volume.admit.') ? 'brickAdmission' : stage;
            const uid = renderer.backend.getTimestampUID(nodes);
            if (uid !== undefined) dispatches.push({ stage: measuredStage, uid });
            if (cpuMs > 5) slowDispatches.push({ frame, stage, cpuMs,
              name: Array.isArray(nodes) ? nodes.map(n => n.name).join(',') : nodes.name });
            return result;
          };
          // Guard readbacks may queue work between display frames. Keep unmatched timestamp IDs
          // until their query batch resolves instead of dropping them at the next frame boundary.
          const consume = (times, stages) => {
            const pending = [];
            for (const dispatch of dispatches) {
              const duration = times.get(dispatch.uid);
              if (duration === undefined) pending.push(dispatch);
              else stages[dispatch.stage] = (stages[dispatch.stage] ?? 0) + duration;
            }
            dispatches = pending;
          };
          let previous = fluid.bounds.clone(), previousSize = fluid.cellSize;
          const frameCount = Number(new URLSearchParams(location.search).get('profileFrames') ?? 360);
          for (frame = 0; frame < frameCount; frame++) {
            const start = performance.now();
            system.advanceFrames(1, 1 / 60);
            const cpuMs = performance.now() - start;
            const gpuMs = await renderer.resolveTimestampsAsync('compute');
            const times = renderer.backend.timestampQueryPool.compute.timestamps, stageGPUms = {};
            consume(times, stageGPUms);
            await renderer.renderAsync(scene, camera);
            const renderGPUms = await renderer.resolveTimestampsAsync('render');
            const visualComputeGPUms = await renderer.resolveTimestampsAsync('compute');
            const visualTimes = renderer.backend.timestampQueryPool.compute.timestamps;
            consume(visualTimes, stageGPUms);
            await renderer.backend.device.queue.onSubmittedWorkDone();
            if (!previous.equals(fluid.bounds) || previousSize !== fluid.cellSize) {
              transitions.push({ frame, cpuMs, wallMs: performance.now() - start,
                requestLatencyMs: requested ? performance.now() - requested.wall : null,
                advancedSimulationSeconds: requested ? system._elapsedTime - requested.time : null,
                cellSize: fluid.cellSize, from: previous.min.toArray().concat(previous.max.toArray()),
                to: fluid.bounds.min.toArray().concat(fluid.bounds.max.toArray()) });
              previous.copy(fluid.bounds); previousSize = fluid.cellSize;
            }
            const support = fluid.occupiedBounds ?? fluid.boundsPrediction?.realized;
            const brickSize = fluid.spatialGrid.brickSize ?? fluid.cellSize * (2 ** fluid.spatialGrid.cellSubdivisions);
            const clearance = support && !support.isEmpty() ? ['x', 'y', 'z'].flatMap(axis => [
              (support.min[axis] - fluid.bounds.min[axis]) / brickSize,
              (fluid.bounds.max[axis] - support.max[axis]) / brickSize,
            ]) : [];
            samples.push({ frame, cpuMs, gpuMs, renderGPUms, visualComputeGPUms, stageGPUms,
              particles: system.liveParticleCount, dimensions: fluid.gridDimensions.toArray(),
              cellSize: fluid.cellSize,
              brickState: { ...fluid.brickDiagnostics }, capacityState: fluid.poolAllocation?.status,
              guardFaces: fluid.guardDiagnostics?.faces.map(face => ({ ...face })),
              supportObservationAgeMs: fluid.guardDiagnostics?.supportObservationAgeMs,
              wallMs: performance.now() - start,
              time: performance.now(), brickSize, clearance,
              support: support && !support.isEmpty() ? support.min.toArray().concat(support.max.toArray()) : null });
            await new Promise(resolve => setTimeout(resolve, 16));
          }
          renderer.compute = compute; renderer.backend.createComputePipeline = pipeline;
          const size = fluid.bounds.getSize(new THREE.Vector3());
          const grid = fluid.volumeGrid ?? fluid.workGrid;
          const diagnostics = fluid.readGridDiagnostics ? await fluid.readGridDiagnostics(renderer) : {};
          return { startup: window.fluidStartup, diagnostics, pipelineEvents,
            initialCapacityDemand: fluid.initialCapacityDemand, capacityMetrics: fluid.capacityMetrics,
            guards: fluid.guardDiagnostics, pool: fluid.poolAllocation?.metrics,
            stages, slowDispatches, transitions, samples, size: size.toArray(), cellSize: fluid.cellSize,
            dimensions: fluid.gridDimensions?.toArray(), resident: grid.capacity, active: diagnostics.activeBricks,
            memoryBytes: fluid.allocatedBytes ?? grid.allocatedBytes,
            sourceIndexCellSize: fluid.sourceGrid?.cellSize,
            particleBounds: fluid.particleBounds.min.toArray().concat(fluid.particleBounds.max.toArray()) };
        });
        results.push({ example, observation, errors });
      } catch (error) { results.push({ example, error: error.stack, errors }); }
      await page.close();
      await fs.writeFile(output, JSON.stringify(results, null, 2));
      console.log(`${example} live-domain profile recorded`);
    }
  } finally { await browser.close(); await site.close(); }
} finally { if (baseline) await fs.writeFile(build, current); }
