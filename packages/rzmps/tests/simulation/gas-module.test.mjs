import assert from 'node:assert/strict';
import test from 'node:test';
import { GasModule, Module, Particle, ParticleSystem } from '../../build/index.mjs';

test('gas discovery preserves tags, enabled selection, stable priorities and particle isolation', () => {
  const a = new GasModule({ tags: ['fire'], priority: 4, modifyGPU() {} });
  const b = new GasModule({ priority: -2, modifyGPU() {} });
  const c = new GasModule({ tags: ['smoke'], modifyRenderGPU() {} });
  const disabled = new GasModule({ enabled: false, modifyGPU() {} });
  const system = new ParticleSystem({ modules: [a, b, c, disabled], emitters: [], renderers: [] });
  assert(a instanceof Module);
  assert(a.supportsGPU);
  assert.equal(a.modifiesParticles, false);
  assert.deepEqual(GasModule.collect(system, ['fire'], 'Simulation'), [b, a]);
  assert.deepEqual(GasModule.collect(system, ['fire'], 'Render'), []);
  assert.deepEqual(GasModule.collect(system, undefined, 'Render'), [c]);
  let calls = 0;
  a.modifyGasGPU = () => { calls++; };
  a._modify = () => { throw new Error('GasModule executed as a CPU particle modifier'); };
  let particleCalls = 0;
  system.addModule(new Module(() => { particleCalls++; }));
  system.particles.push(new Particle({ lifetime: 10 }));
  system.advanceFrames(1, 1 / 60);
  assert.equal(calls, 0, 'CPU particle processing cannot execute a gas callback');
  assert.equal(particleCalls, 1, 'ordinary particle modules retain their normal execution');
});

test('stage-local callback and dependency invalidation preserves unrelated graph keys', () => {
  let parameter = 1;
  const module = new GasModule({ modifyGPU() {}, modifyRenderGPU() {}, deps: () => [parameter] });
  const sim = module.graphKey('Simulation'), render = module.graphKey('Render');
  assert.equal(module.graphKey('Simulation'), sim);
  module.modifyRenderGPU = () => {};
  assert.notEqual(module.graphKey('Render'), render);
  assert.equal(module.graphKey('Simulation'), sim);
  const nextRender = module.graphKey('Render');
  module.modifyGasGPU = () => {};
  assert.notEqual(module.graphKey('Simulation'), sim);
  assert.equal(module.graphKey('Render'), nextRender);
  const nextSim = module.graphKey('Simulation');
  parameter++;
  assert.notEqual(module.graphKey('Simulation'), nextSim);
  const depsRender = module.graphKey('Render');
  module.needsUpdate = true;
  assert.notEqual(module.graphKey('Render'), depsRender);
});


test('gas stages accept enum keys and reject unknown JavaScript values', () => {
  const module = new GasModule({ modifyGPU() {}, modifyRenderGPU() {} });
  const owner = new ParticleSystem({ modules: [module], emitters: [], renderers: [] });
  assert.equal(typeof module.graphKey('Simulation'), 'string');
  assert.equal(typeof module.graphKey('Render'), 'string');
  assert.deepEqual(GasModule.collect(owner, undefined, 'Render'), [module]);
  assert.throws(() => module.graphKey('Unknown'), /Unknown gas module stage/);
  assert.throws(() => GasModule.collect(owner, undefined, 'Unknown'), /Unknown gas module stage/);
  owner.destroy();
});
