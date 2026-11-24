import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { createServer } from 'vite';
import { browserLaunchOptions } from '../../../scripts/browser/launch.utils.mjs';
import { openFixture } from './fluids/openFixture.mjs';

test('physical source cache compares with direct gathering on the same frozen particle input',
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
        `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/heatLaser.html`, errors);
      const result = await page.evaluate(async timerURL => {
        const { passTimer } = await import(timerURL);
        const { system, renderer, THREE, tsl } = window.laser;
        const gas = system.userData.heatLaser.gas;
        const child = [...system.subSystems.keys()].find(owner => owner.name === 'Laser Fire and Smoke');
        const { If, vec4 } = tsl;
        system.userData.heatLaser.aimAt(new THREE.Vector3(-2, 2, -3));
        // Registered sources use the same initializer and deposition path as the demo burns.
        for (let i = 0; i < 32; i++) system.registerEmissionSource({ tags: ['laser-burn'], lifetime: 16,
          transform: new THREE.Matrix4().makeTranslation(-2 + (i % 8) * 0.04, 2 + Math.floor(i / 8) * 0.04, -2.98) });
        child.emitters[0].rate = 60;
        system.start(false); await window.runLaser(120);
        const context = gas.poolContext, grid = gas.poolParticleGrid;
        gas.sourceGrid.rebuild(renderer, context.buffers);
        const gather = gas.gatherPhysicalSources, initialize = gas.gatherInitializedEmission;
        system.benchmarks.start();
        const prototype = Object.getPrototypeOf(gas.benchmarks), begin = prototype.begin;
        let stage = 'unscoped';
        prototype.begin = function (name) {
          const previous = stage, end = begin.call(this, name); stage = name;
          return () => { stage = previous; end?.(); };
        };
        const timer = passTimer(renderer.backend.device, renderer.backend, () => stage);
        const scopes = new Set(['sourceMomentGather', 'velocitySourceInjection',
          'scalarSourceInitialization', 'scalarSourceInjection']);
        const rows = [];
        for (const mode of ['cached', 'direct', 'cached-repeat']) {
          gas.gatherPhysicalSources = gather;
          gas.gatherInitializedEmission = initialize;
          if (mode === 'direct') {
            gas.gatherInitializedEmission = function (...args) { return initialize.apply(this, args.slice(0, 6)); };
            gas.gatherPhysicalSources = function (ctx, gpu, source, tagMask) {
              const node = this.computeCells(index => {
                this.initializedSource.element(index).assign(vec4(0));
                If(this.volumeGrid.sourceActive(index), () => {
                  const value = initialize.call(this, this.cellCenter(this.cellCoordinate(index)),
                    this.cellCoordinate(index), ctx, source, tagMask);
                  const coupling = this.sourceStrength > 0
                    ? value.emission.density.div(this.sourceStrength) : value.mass;
                  this.initializedSource.element(index).assign(vec4(value.emission.velocity, coupling));
                });
              });
              this.benchmarks.span('sourceMomentGather', () => gpu.compute(node));
            };
          }
          gas.gpuCacheKey = '';
          const fields = ['densityCurrent', 'densityNext', 'colorCurrent', 'colorNext'];
          const saved = fields.map(name => gas[name]);
          const previousPreparing = gas.preparingPool, compute = renderer.compute;
          const nodes = [];
          gas.preparingPool = true;
          renderer.compute = value => {
            if (scopes.has(stage)) nodes.push(...(Array.isArray(value) ? value : [value]));
            return undefined;
          };
          try { gas.getPressureProjection().forPreparation(() => gas.computeTransport(context, renderer, grid)); }
          finally {
            renderer.compute = compute; gas.preparingPool = previousPreparing;
            fields.forEach((name, i) => { gas[name] = saved[i]; });
          }
          await renderer.compileComputeAsync(nodes);
          for (let warm = 0; warm < 3; warm++) renderer.compute(nodes);
          await renderer.backend.device.queue.onSubmittedWorkDone();
          const samples = [];
          for (let sample = 0; sample < 16; sample++) {
            timer.start(); renderer.compute(nodes); samples.push(await timer.finish());
          }
          rows.push({ mode, nodeCount: nodes.length, samples });
          nodes.forEach(node => node.dispose());
        }
        timer.dispose(); prototype.begin = begin;
        return { rows, particles: child.liveParticleCount, slots: context.buffers.capacity,
          residentPages: gas.brickDiagnostics.resident, cellWidth: gas.cellSize, errors: window.laser.errors };
      }, `/@fs${path.resolve('benchmarks/lib/passTimer.js')}`);
      await writeFile('/tmp/gas-source-cache-comparison.json', JSON.stringify(result, null, 2));
      const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
      console.log('Source cache A/B:', JSON.stringify({ particles: result.particles, slots: result.slots,
        residentPages: result.residentPages, cellWidth: result.cellWidth,
        modes: result.rows.map(row => ({ mode: row.mode, nodes: row.nodeCount,
          GPUms: median(row.samples.map(sample => sample.totalGPUms)) })) }));
      assert.deepEqual(errors, []); assert.deepEqual(result.errors, []);
      assert(result.particles > 500); assert.equal(result.slots, 4096);
      assert(result.rows.every(row => row.samples.length === 16 && row.nodeCount > 0));
    } finally { await browser?.close(); await server.close(); }
  });
