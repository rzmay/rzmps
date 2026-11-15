/* global window */
// Explicit finalization benchmark; never updates public benchmark/PR artifacts.
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../site/dev.mjs';
import { openFixture } from '../../tests/preview/fluids/openFixture.mjs';

const output = process.argv[2] ?? '/tmp/rzmps-reactive-comparison.json';
const baseline = process.argv[3];
const build = path.resolve('packages/rzmps/build/index.mjs');
const current = await fs.readFile(build);
const results = [];
try {
  for (const variant of baseline ? ['previous', 'reactive'] : ['reactive']) {
    await fs.writeFile(build, variant === 'previous' ? await fs.readFile(baseline) : current);
    const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
    await site.demo.watcher.close();
    const browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
    try {
      for (const example of ['volumetricFire', 'volumetricSmoke', 'flipFluid', 'vertical/generic']) {
        const page = await browser.newPage(), errors = [];
        await page.evaluateOnNewDocument(() => {
          let seed = 173;
          Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
        });
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        const file = example === 'vertical/generic' ? 'reactive-domains.html' : 'fluid.html';
        const fixture = path.resolve(import.meta.dirname, '../../tests/preview/fluids/fixtures', file);
        const query = new URLSearchParams({ example, profile: 'true', reviewGrid: '2,3' });
        try {
          await openFixture(page,
            `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}?${query}`, errors);
          const observation = await page.evaluate(async () => {
            if (!window.debugFluid) return window.benchmarkDomainLayout();
            const { system, flip: fluid, renderer, scene, camera, THREE } = window.debugFluid;
            const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
            const resolve = type => renderer.resolveTimestampsAsync(type);
            fluid.adaptiveTimestep = false;
            // Separate warmed execution from compilation; keep this diagnostic intentionally short.
            for (let i = 0; i < 20; i++) { system.advanceFrames(1, 1 / 60); await resolve('compute'); }
            // Drain asynchronous prediction, then isolate warm fixed-domain execution.
            for (let i = 0; i < 100 && fluid.boundsReadPending; i++) {
              await new Promise(resolve => setTimeout(resolve, 10));
            }
            fluid.refreshBounds = () => {};
            for (let i = 0; i < 4; i++) { system.advanceFrames(1, 1 / 60); await resolve('compute'); }
            const simulation = [], rendering = [], stageSamples = [];
            let stage = 'other', dispatches = [];
            for (const [method, label] of [['solveProjection', 'pressure'], ['computeTransport', 'transport'],
              ['remapFields', 'allocation/remap']]) {
              const original = fluid[method];
              if (!original) continue;
              fluid[method] = function (...args) {
                const previous = stage; stage = label;
                try { return original.apply(this, args); } finally { stage = previous; }
              };
            }
            const compute = renderer.compute;
            renderer.compute = function (nodes, ...args) {
              const result = compute.call(this, nodes, ...args);
              dispatches.push({ uid: renderer.backend.getTimestampUID(nodes), stage });
              return result;
            };
            for (let i = 0; i < 4; i++) {
              dispatches = [];
              system.advanceFrames(1, 1 / 60); simulation.push(await resolve('compute'));
              const timings = renderer.backend.timestampQueryPool.compute.timestamps, stages = {};
              for (const dispatch of dispatches) {
                stages[dispatch.stage] = (stages[dispatch.stage] ?? 0) + (timings.get(dispatch.uid) ?? 0);
              }
              stageSamples.push(stages);
              await renderer.renderAsync(scene, camera); rendering.push(await resolve('render'));
            }
            renderer.compute = compute;
            const size = fluid.bounds.getSize(new THREE.Vector3());
            const grid = fluid.volumeGrid ?? fluid.workGrid;
            const diagnostics = fluid.readGridDiagnostics ? await fluid.readGridDiagnostics(renderer) : {};
            return { size: size.toArray(), dimensions: fluid.gridDimensions?.toArray()
                ?? [fluid.resolution, fluid.resolution, fluid.resolution],
              volume: size.x * size.y * size.z, cellSize: fluid.cellSize,
              qualitySide: fluid.spatialGrid.volumeQualityTier ?? size.x,
              active: diagnostics.activeBricks ?? null, resident: grid.capacity,
              memoryBytes: fluid.allocatedBytes ?? [fluid.velocityCurrentAttribute, fluid.velocityNextAttribute,
                fluid.pressureCurrentAttribute, fluid.pressureNextAttribute, fluid.divergenceAttribute,
                fluid.solidAttribute, fluid.boundaryAttribute].reduce((sum, a) => sum + a.array.byteLength, 0)
                  + grid.allocatedBytes + (fluid.pressureProjection?.allocatedBytes ?? 0),
              stageGPUms: Object.fromEntries(['pressure', 'transport', 'allocation/remap', 'other']
                .map(stage => [stage, median(stageSamples.map(sample => sample[stage] ?? 0))])),
              simulationGPUms: median(simulation), renderGPUms: median(rendering),
              particleCount: system.liveParticleCount,
              domainDiagnostics: fluid.spatialGrid.domainDiagnostics ?? null };
          });
          results.push({ variant, example, observation, errors });
        } catch (error) { results.push({ variant, example, error: error.stack, errors }); }
        await page.close();
        await fs.writeFile(output, JSON.stringify(results, null, 2));
        console.log(`${variant}: ${example} recorded`);
      }
    } finally { await browser.close(); await site.close(); }
  }
} finally { await fs.writeFile(build, current); }
