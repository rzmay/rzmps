import assert from 'node:assert/strict';
import { Particle, ParticleSystem, Module } from '../../build/index.mjs';

const makeSystem = () => new ParticleSystem({ emitters: [], modules: [], renderers: [] });

// Clearing a system invalidates in-flight native events and clears owned transport
// state without removing subscriptions or registered CPU emission origins.
{
  const system = makeSystem();
  const source = system.registerEmissionSource({ transform: system.matrix.clone() });
  const received = [];
  system.onEvent('pulse', event => received.push(event));
  let resolveReadback;
  const buffer = {
    sequence: 1, capacity: 32,
    readback: () => new Promise(resolve => { resolveReadback = resolve; }),
  };
  const execution = {
    required: () => true,
    lifecycle: () => system.gpuSimulation._gpuLifecycleGeneration,
    identity: () => undefined, tags: () => undefined, debug: () => {},
    deliver: event => received.push(event),
  };
  system.eventRuntime.scheduleReadback(buffer, {
    backend: {}, getArrayBufferAsync() {},
  }, execution);
  assert.equal(system.eventRuntime._gpuEventReadbacksPending, 1);
  const generation = execution.lifecycle();
  system.addParticle(new Particle());
  system.clearParticles();
  resolveReadback({ sequence: 1, events: [{ type: 4, particle: new Particle() }],
    rawEventCount: 1, capacity: 32, overflowCount: 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(execution.lifecycle() > generation);
  assert.deepEqual(received, []);
  assert.equal(system.eventRuntime._gpuEventReadbacksPending, 0);
  assert.equal(system.eventRuntime._gpuCompletedEventBatches.size, 0);
  assert.equal(system.particles.length, 0);
  system.updateSource(source.id, { alpha: 0.25 });
  assert.equal(source.alpha, 0.25);
  system.emitEvent('pulse');
  assert.equal(received.length, 1);
  system.destroy();
  assert.equal(source.alive, false);
}

// Resource owners are isolated per system, and disposal remains with each owner.
{
  const first = makeSystem();
  const second = makeSystem();
  let disposed = 0;
  first.frameRuntime._sourceFrames = { dispose: () => { disposed++; } };
  first.frameRuntime._sourceReadbackPending = true;
  first.spatialRuntime._particleSpacing.set('particle', 2);
  first.clearParticles();
  assert.equal(disposed, 1);
  assert.equal(first.frameRuntime._sourceFrames, undefined);
  assert.equal(first.frameRuntime._sourceReadbackPending, false);
  assert.equal(first.spatialRuntime._particleSpacing.size, 0);
  assert.notEqual(first.eventRuntime, second.eventRuntime);
  assert.notEqual(first.emissionRuntime, second.emissionRuntime);
  first.destroy(); second.destroy();
}

// Existing subclass bindings keep their identity through the preferred API name.
{
  const component = new Module(() => {});
  assert.equal(component.evaluateDynamicGPU, component.gpuParameters);
  const previous = ParticleSystem.Settings.GPU_DYNAMIC_VALUE_RESOLUTION;
  ParticleSystem.Settings.GPU_DYNAMIC_VALUE_RESOLUTION = 8;
  assert.equal(ParticleSystem.Settings.GPU_DYNAMIC_VALUE_RESOLUTION, 8);
  ParticleSystem.Settings.GPU_DYNAMIC_VALUE_RESOLUTION = previous;
}
console.log('Feature lifecycle tests passed');
