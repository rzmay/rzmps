import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { browserLaunchOptions } from '../../../../scripts/browser/launch.utils.mjs';
import { startSiteDev } from '../../../../scripts/site/dev.mjs';
import { openFixture } from './openFixture.mjs';

test('source initialization reads live clocks and keyed metadata without particle readback or recompilation',
  { timeout: 120000 }, async () => {
    const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
    await site.demo.watcher.close();
    let browser;
    try {
      browser = await puppeteer.launch(browserLaunchOptions('test'));
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      const origin = `http://127.0.0.1:${site.demo.httpServer.address().port}`;
      await openFixture(page, `${origin}/@fs${path.resolve(import.meta.dirname, 'fixtures/corrective.html')}`, errors);
      const result = await page.evaluate(async url => {
        const { Particle, ParticleSpatialGrid, createGPUParticleBufferState } = await import(url);
        const { renderer, system, gas, GasModule, THREE, StorageBufferAttribute, tsl } = window.debugBehavior;
        const { Fn, If, ivec3, float, vec3, vec4, storage, uint } = tsl;
        const sources = [1, 3].map((age, i) => system.registerEmissionSource({
          transform: new THREE.Matrix4(), age, lifetime: 4, metadata: { 'heat factor': i + 1 } }));
        const particles = sources.map(source => {
          const p = new Particle({ lifetime: 10, mass: 1, alpha: 1 });
          p.scale.setScalar(0.2); system.bindParticleSource(p, source); return p;
        });
        const buffers = createGPUParticleBufferState(particles, 4);
        const grid = new ParticleSpatialGrid({ bounds: gas.bounds.clone(), brickSubdivisions: 1, cellSubdivisions: 2 });
        grid.initialize(renderer, buffers); grid.rebuild(renderer, buffers);
        const cooling = new GasModule({ initializeGPU(particles, emission) {
          const heat = float(0).toVar(), count = float(0).toVar(), metadata = float(0).toVar();
          particles.forEach(p => {
            If(p.source.valid, () => {
              heat.addAssign(float(1).sub(p.source.age.div(p.source.lifetime)));
              metadata.addAssign(p.source.metadata['heat factor']); count.addAssign(1);
            });
          });
          If(count.greaterThan(0), () => {
            emission.temperature.mulAssign(heat.div(count));
            emission.density.mulAssign(metadata.div(count));
          });
          emission.color.assign(vec3(0.2, 0.4, 0.6));
          emission.velocity.assign(vec3(1, 2, 3));
        } });
        system.addModule(cooling); gas.prepareGasEffects(system);
        gas.sourceTemperature = 4; gas.sourceStrength = 1; gas.syncSimulationUniforms();
        gas.sourceData.update(system);
        const output = new StorageBufferAttribute(new Float32Array(12), 4), target = storage(output, 'vec4', 3);
        const context = { system, buffers, deltaTimeNode: float(0.1), elapsedTimeNode: float(1) };
        const node = Fn(() => {
          const { emission, mass } = gas.gatherInitializedEmission(vec3(0), ivec3(0), context, grid);
          target.element(0).assign(vec4(emission.density, emission.temperature, mass, 0));
          target.element(1).assign(vec4(emission.velocity, 0));
          target.element(2).assign(vec4(emission.color, 0));
        })().compute(1);
        const gather = Fn(() => {
          const raw = gas.gatherSourceMoments(vec3(0), context, grid);
          gas.visualDensity.element(uint(0)).assign(vec4(raw.mass, raw.heat, raw.count, 0));
          gas.visualColor.element(uint(0)).assign(vec4(raw.color, 0));
          gas.sourceMomentum.element(uint(0)).assign(vec4(raw.momentum, 0));
        })().compute(1);
        const cached = Fn(() => {
          const { emission, mass } = gas.gatherInitializedEmission(vec3(0), ivec3(0), context,
            grid, undefined, undefined, uint(0));
          gas.visualDensity.element(uint(0)).assign(vec4(emission.density, emission.temperature, mass, 0));
          gas.visualColor.element(uint(0)).assign(vec4(emission.velocity, 0));
          gas.sourceMomentum.element(uint(0)).assign(vec4(emission.color, 0));
        })().compute(1);
        const readCached = Fn(() => {
          target.element(0).assign(gas.visualDensity.element(uint(0)));
          target.element(1).assign(gas.visualColor.element(uint(0)));
          target.element(2).assign(gas.sourceMomentum.element(uint(0)));
        })().compute(1);
        let maximumCacheError = 0;
        let pipelines = 0;
        const create = renderer.backend.device.createComputePipeline.bind(renderer.backend.device);
        renderer.backend.device.createComputePipeline = options => { pipelines++; return create(options); };
        const sample = async () => {
          gas.sourceData.update(system); renderer.compute(node);
          const direct = [...new Float32Array(await renderer.getArrayBufferAsync(output))];
          renderer.compute([gather, cached, readCached]);
          const shared = [...new Float32Array(await renderer.getArrayBufferAsync(output))];
          maximumCacheError = Math.max(maximumCacheError, ...direct.map((value, i) => Math.abs(value - shared[i])));
          return direct;
        };
        const first = await sample(), initialPipelines = pipelines;
        sources[1].update({ lifetime: 8, metadata: { 'heat factor': 4 } });
        const reheated = await sample();
        const extra = system.registerEmissionSource({ transform: new THREE.Matrix4(), age: 0, lifetime: 4 });
        const extraParticle = new Particle({ lifetime: 10 });
        system.bindParticleSource(extraParticle, extra);
        // Grow the live table after its first GPU allocation without recompiling the existing gather.
        const grown = await sample();
        const reused = pipelines === initialPipelines;
        extra.dispose();
        sources.forEach(source => source.dispose());
        const absent = await sample();
        const empty = await (async () => {
          buffers.upload([]); grid.rebuild(renderer, buffers);
          return sample();
        })();
        [node, gather, cached, readCached].forEach(program => program.dispose());
        output.dispose(); grid.dispose(); buffers.dispose();
        return { first, reheated, grown, absent, empty, reused, maximumCacheError };
      }, `/@fs${path.resolve('packages/rzmps/build/index.mjs')}`);
      assert(result.maximumCacheError < 1e-5, 'cached physical moments must match direct source initialization');
      assert.equal(result.empty[0], 0); assert.equal(result.empty[2], 0);
      assert(result.first[2] > 0, JSON.stringify(result));
      assert(Math.abs(result.first[1] - 2) < 1e-5, JSON.stringify(result));
      assert(Math.abs(result.first[0] / result.first[2] - 1.5) < 1e-5);
      assert(Math.abs(result.reheated[1] - 2.75) < 1e-5);
      assert(Math.abs(result.reheated[0] / result.reheated[2] - 2.5) < 1e-5);
      assert.deepEqual(result.first.slice(4, 7), [1, 2, 3]);
      assert(Math.abs(result.first[8] - 0.2) < 1e-5);
      assert.deepEqual(result.grown, result.reheated);
      assert(result.absent.every(Number.isFinite));
      assert(result.reused, 'live source clocks and metadata must reuse the compiled deposition graph');
      const growth = await page.evaluate(async () => {
        await window.testPreparation();
        return window.testGrowth(8);
      });
      assert(growth.retained, JSON.stringify(growth.mismatchedFields));
      assert(growth.cachedWriteExact && growth.newSentinelsZero);
      assert.equal(growth.growthMetrics.pipelines, 0);
      assert.deepEqual(errors, []);
    } finally { await browser?.close(); await site.close(); }
  });
