import assert from 'node:assert/strict';
import test from 'node:test';
import { Emitter, EventReceiver, Module, Particle, ParticleSystem, Renderer } from '../build/index.mjs';

function createSystem(modules) {
  const system = new ParticleSystem({ emitters: [], renderers: [], modules, gpuProcessing: false });
  system.particles.push(new Particle({ lifetime: 10 }), new Particle({ lifetime: 10 }));
  system.deltaTime = 0.125;
  return system;
}

test('functional preparation, conditions, and updates share one frozen context and event batch', () => {
  const preparations = [];
  const conditions = [];
  const updates = [];
  const module = new Module((particle, dt, context) => {
    updates.push(context);
    assert.equal(dt, context.deltaTime);
    assert.equal(context.octree, module.getParticleOctree());
    if (particle === context.system.particles[0]) context.system.emitEvent('tick', { step: 2 });
  }, {
    events: ['tick'],
    useOctree: true,
    prepare(context) {
      preparations.push(context);
      assert.ok(context.octree);
      assert.ok(Object.isFrozen(context));
      assert.ok(Object.isFrozen(context.events));
    },
    condition(_particle, _dt, context) {
      conditions.push(context);
      return true;
    },
  });
  const system = createSystem([module]);
  try {
    system.emitEvent('tick', { step: 1 });
    system._processParticles();
    assert.equal(preparations.length, 1);
    assert.deepEqual(updates, [preparations[0], preparations[0]]);
    assert.deepEqual(conditions, updates);
    assert.deepEqual(preparations[0].events.map(event => event.data.step), [1]);
    assert.equal(preparations[0].system, system);
    assert.equal(preparations[0].deltaTime, 0.125);

    system._processParticles();
    assert.equal(preparations.length, 2);
    assert.notEqual(preparations[1], preparations[0]);
    assert.deepEqual(preparations[1].events.map(event => event.data.step), [2]);
    assert.deepEqual(preparations[0].events.map(event => event.data.step), [1]);
  } finally { system.destroy(); }
});

test('class preparation uses the same API and events emitted during preparation wait for the next execution', () => {
  const observed = [];
  class Scheduler extends Module {
    constructor() {
      super((_particle, _dt, context) => {
        assert.equal(context, this.executionContext);
      }, { events: ['tick'] });
    }

    prepare(context) {
      super.prepare(context);
      observed.push(context.events);
      context.system.emitEvent('tick', observed.length);
    }
  }
  const receiverBatches = [];
  const receiver = new Module((_particle, _dt, context) => {
    receiverBatches.push(context.events);
  }, { events: ['tick'] });
  const system = createSystem([new Scheduler(), receiver]);
  try {
    system._processParticles();
    assert.deepEqual(observed[0], []);
    assert.deepEqual(receiverBatches, [observed[0], observed[0]]);
    system._processParticles();
    assert.deepEqual(observed[1].map(event => event.data), [1]);
    assert.deepEqual(receiverBatches[2].map(event => event.data), [1]);
    assert.equal(receiverBatches[2], receiverBatches[3]);
  } finally { system.destroy(); }
});

class EventTestRenderer extends Renderer {
  setup() {}
  _update() {}
  destroy() {}
}

for (const [name, create] of [
  ['module', options => new Module(() => {}, options)],
  ['emitter', options => new Emitter({ rate: 0, ...options })],
  ['renderer', options => new EventTestRenderer(options)],
]) {
  test(`${name} inherits receiver batching, retained context, and subscription cleanup`, () => {
    const receiver = create({ events: ['pulse'] });
    const system = createSystem([]);
    try {
      assert.ok(receiver instanceof EventReceiver);
      receiver.beginExecution(system, 0);
      system.emitEvent('pulse', { intensity: 2 });
      const context = receiver.beginExecution(system, 0.1);
      assert.equal(receiver.executionContext, context);
      assert.ok(Object.isFrozen(context));
      assert.deepEqual(context.events.map(event => event.data), [{ intensity: 2 }]);
      system.emitEvent('pulse', { intensity: 3 });
      assert.equal(context.events.length, 1);
      assert.deepEqual(receiver.beginExecution(system, 0.1).events.map(event => event.data), [{ intensity: 3 }]);
      receiver.dispose();
      assert.equal(receiver.executionContext, undefined);
      system.emitEvent('pulse', { intensity: 4 });
      assert.deepEqual(receiver.beginExecution(system, 0.1).events, []);
    } finally {
      receiver.dispose();
      system.destroy();
    }
  });
}
