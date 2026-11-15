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
  assert.deepEqual(GasModule.collect(system, ['fire'], 'simulation'), [b, a]);
  assert.deepEqual(GasModule.collect(system, ['fire'], 'render'), []);
  assert.deepEqual(GasModule.collect(system, undefined, 'render'), [c]);
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
  const sim = module.graphKey('simulation'), render = module.graphKey('render');
  assert.equal(module.graphKey('simulation'), sim);
  module.modifyRenderGPU = () => {};
  assert.notEqual(module.graphKey('render'), render);
  assert.equal(module.graphKey('simulation'), sim);
  const nextRender = module.graphKey('render');
  module.modifyGasGPU = () => {};
  assert.notEqual(module.graphKey('simulation'), sim);
  assert.equal(module.graphKey('render'), nextRender);
  const nextSim = module.graphKey('simulation');
  parameter++;
  assert.notEqual(module.graphKey('simulation'), nextSim);
  const depsRender = module.graphKey('render');
  module.needsUpdate = true;
  assert.notEqual(module.graphKey('render'), depsRender);
});
