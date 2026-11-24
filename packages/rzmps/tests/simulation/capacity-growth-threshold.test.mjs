import assert from 'node:assert/strict';
import test from 'node:test';
import { Emitter, ParticleSystem } from '../../build/index.mjs';

test('capacity growth threshold defaults to full estimated use and supports realtime changes', () => {
  const system = new ParticleSystem({ emitters: [], renderers: [] });
  assert.equal(system.capacityGrowthThreshold, 1);
  system.capacityGrowthThreshold = 0.5;
  assert.equal(system.capacityGrowthThreshold, 0.5);
  for (const value of [0, -1, 1.1, NaN, Infinity])
    assert.throws(() => { system.capacityGrowthThreshold = value; }, /capacityGrowthThreshold/);
  assert.equal(system.capacityGrowthThreshold, 0.5);
  system.destroy();
  const configured = new ParticleSystem({ emitters: [], renderers: [], capacityGrowthThreshold: 0.75 });
  assert.equal(configured.capacityGrowthThreshold, 0.75);
  configured.destroy();
});


test('population prediction counts live source executions and invalidates on source removal', () => {
  const emitter = new Emitter({ rate: 60, sources: { tags: ['burn'] },
    emitContinuous: true, initialValues: { lifetime: 2 } });
  const system = new ParticleSystem({ gpuProcessing: false, emitters: [emitter], renderers: [] });
  const sources = [0, 1, 2].map(() => system.registerEmissionSource({ tags: ['burn'], lifetime: 10 }));
  system.start(false); system.advanceFrames(1, 1 / 60);
  assert.equal(system.estimateParticleCount(), 360);
  sources[0].dispose();
  assert.equal(system.estimateParticleCount(), 240);
  system.destroy();
});


test('initial GPU capacity is per-system, rounded, and bounded by the particle ceiling', () => {
  const system = new ParticleSystem({ emitters: [], renderers: [], initialCapacity: 3000, maxParticles: 10000 });
  assert.equal(system.gpuSimulation._getInitialGPUBufferCapacity(), 4096);
  system.maxParticles = 3000;
  assert.equal(system.gpuSimulation._getInitialGPUBufferCapacity(), 3000);
  const other = new ParticleSystem({ emitters: [], renderers: [] });
  assert.equal(other.initialCapacity, ParticleSystem.Settings.GPU_INITIAL_BUFFER_SIZE);
  system.destroy(); other.destroy();
});
