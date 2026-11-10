import assert from 'node:assert/strict';
import test from 'node:test';
import { Emitter, EventReceiver, Module, Particle, ParticleSystem } from '../../build/index.mjs';

const system = options => new ParticleSystem({
  emitters: [], renderers: [], modules: [], gpuProcessing: false, gravityModifier: 0, ...options,
});

for (const name of ['spawn', 'death', 'collision', 'pulse']) {
  test(`${name}: exclusive origins, arrays, deduplication, and immediate relatives`, () => {
    const ancestor = system();
    const parent = system();
    const owner = system();
    const child = system();
    const descendant = system();
    const sibling = system();
    ancestor.addSubSystem(parent);
    parent.addSubSystem(owner);
    parent.addSubSystem(sibling);
    owner.addSubSystem(child);
    child.addSubSystem(descendant);
    const cases = [
      ['local', [owner]], ['parent', [parent]], ['child', [child]],
      [['local', 'parent'], [owner, parent]],
      [['local', 'parent', 'child', 'parent', 'local'], [owner, parent, child]],
      [[], []],
    ];
    try {
      for (const [scope, expected] of cases) {
        const receiver = new EventReceiver({ events: [name, name], eventScope: scope });
        receiver.begin(owner, 0);
        for (const producer of [ancestor, parent, owner, child, descendant, sibling]) {
          producer.emitEvent(name, { producer: producer.uuid });
        }
        const batch = receiver.begin(owner, 0).events;
        assert.equal(batch.length, expected.length);
        assert.deepEqual(new Set(batch.map(event => event.origin)), new Set(expected));
        assert.equal(new Set(batch.map(event => event.id)).size, batch.length);
        assert.ok(batch.every(event => event.data.producer === event.origin.uuid));
        receiver.dispose();
      }
    } finally { ancestor.destroy(); }
  });
}

test('parent scope on a root has no producers; module defaults remain local', () => {
  const local = new Module(() => {}, { events: ['pulse'] });
  const root = system({ modules: [local] });
  const parent = new EventReceiver({ events: ['pulse'], eventScope: 'parent' });
  try {
    parent.begin(root, 0);
    root.emitEvent('pulse');
    assert.equal(parent.begin(root, 0).events.length, 0);
    assert.equal(local.beginExecution(root, 0).events.length, 1);
    assert.deepEqual(parent.visibleSystems(root), []);
  } finally { parent.dispose(); root.destroy(); }
});

for (const tags of [undefined, ['inherited']]) {
  for (const scope of [undefined, ['local', 'parent']]) {
    test(`death emission: scope=${JSON.stringify(scope)}, tags=${JSON.stringify(tags)}`, () => {
      let births = 0;
      const emitter = new Emitter({ emitOnDeath: true, eventScope: scope,
        bursts: { time: 0, count: 1 }, initialValues: { lifetime: 0.05 } });
      const child = system({ duration: 0.1, looping: false, emitters: [emitter] });
      const parent = system();
      child.onSpawn(() => { births++; });
      parent.addSubSystem(child);
      parent.addParticle(new Particle({ lifetime: 0.05, tags }));
      try {
        parent.advanceFrames(12, 0.05);
        if (scope === undefined) assert.equal(births, 1, 'only parent death triggers the default subsystem');
        else assert.ok(births > 1, 'explicit local subscription must receive its own emitter deaths');
      } finally { parent.destroy(); }
    });
  }
}

test('relationship scope overrides replace emitter scope and do not leak through detach or reparent', () => {
  const emitter = new Emitter({ events: ['pulse'], eventScope: 'local', emitContinuous: false });
  const child = system({ emitters: [emitter] });
  const first = system();
  const second = system();
  try {
    first.addSubSystem(child, { eventScope: 'parent' });
    first.emitEvent('pulse', 'parent');
    child.emitEvent('pulse', 'local');
    child.emissionRuntime._updateEmitterInstances();
    assert.deepEqual(emitter.executionContext.events.map(event => event.data), ['parent']);
    assert.equal(emitter.eventScope, 'local');
    assert.equal(child.getEmitterOptions(emitter).eventScope, 'parent');

    second.addSubSystem(child);
    assert.equal(child.getEmitterOptions(emitter).eventScope, 'local');
    first.emitEvent('pulse', 'old');
    second.emitEvent('pulse', 'new');
    child.emitEvent('pulse', 'local-again');
    child.emissionRuntime._updateEmitterInstances();
    assert.deepEqual(emitter.executionContext.events.map(event => event.data), ['local-again']);

    second.removeSubSystem(child);
    assert.equal(child.getEmitterOptions(emitter).eventScope, 'local');
    assert.equal(first.eventRuntime._eventObservers.size, 0);
    assert.equal(second.eventRuntime._eventObservers.size, 0);
  } finally { child.destroy(); first.destroy(); second.destroy(); }
});

test('parent custom-event emission preserves producer identity and does not forward child events', () => {
  const parent = system();
  const emitter = new Emitter({ onEvent: ['pulse'], bursts: { time: 0, count: 1 } });
  const child = system({ emitters: [emitter] });
  parent.addSubSystem(child);
  const seen = [];
  const unsubscribe = parent.onEvent('pulse', event => seen.push(event));
  try {
    child.emitEvent('pulse', 'child');
    assert.equal(seen.length, 0);
    assert.equal([...child.emissionRuntime._emitterInstances].filter(instance => instance.source.kind === 'snapshot').length, 0);
    parent.emitEvent('pulse', 'parent');
    assert.equal([...child.emissionRuntime._emitterInstances].filter(instance => instance.source.kind === 'snapshot').length, 1);
    child.emissionRuntime._updateEmitterInstances();
    assert.equal(emitter.executionContext.events[0], seen[0]);
    assert.equal(seen[0].origin, parent);
  } finally { unsubscribe(); parent.destroy(); }
});


test('sub-particle birth tags come from its emitter, independently of particle and registered sources', () => {
  for (const registered of [false, true]) for (const custom of [false, true]) {
    const parent = system();
    const emitter = new Emitter({ tags: ['child'], bursts: { time: 0, count: 1 },
      ...(custom ? { onEvent: ['pulse'] } : { emitOnSpawn: true }) });
    const child = system({ duration: 0.5, looping: false, emitters: [emitter] });
    parent.addSubSystem(child);
    try {
      const source = registered ? parent.registerEmissionSource({ tags: ['source'] })
        : new Particle({ tags: ['source'], lifetime: 5 });
      if (!registered) { parent.addParticle(source); parent._notifySpawn(source); }
      if (custom) parent.emitEvent(source.id, 'pulse');
      parent.advanceFrames(1, 0.05);
      assert.equal(child.particles.length, 1);
      assert.deepEqual(child.particles[0].tags, ['child']);
      assert.deepEqual(source.tags, ['source']);
    } finally { parent.destroy(); }
  }
});

test('empty receivers discover subscriptions added between updates and release removed names', () => {
  const receiver = new Module(() => {});
  const owner = system({ modules: [receiver] });
  try {
    owner.advanceFrames(1);
    receiver.events = ['pulse'];
    owner.emitEvent('pulse', 42);
    assert.equal(receiver.beginExecution(owner, 0).events[0].data, 42);
    receiver.events = [];
    owner.emitEvent('pulse', 99);
    assert.equal(receiver.beginExecution(owner, 0).events.length, 0);
    const emitter = new Emitter({ rate: 0 });
    owner.emitters = [emitter];
    emitter.emission.events = ['pulse'];
    owner.emitEvent('pulse', 7);
    owner.advanceFrames(1);
    assert.equal(emitter.executionContext.events[0].data, 7);
  } finally { owner.destroy(); }
});

test('initially empty emitter subscriptions discover relationship changes between updates', () => {
  const parent = system();
  const emitter = new Emitter({ bursts: { time: 0, count: 1 }, initialValues: { lifetime: 10 } });
  const child = system({ emitters: [emitter], duration: 0.1 });
  parent.addSubSystem(child, { emitContinuous: false, emitOnSpawn: false });
  try {
    parent.advanceFrames(1);
    parent.subSystems.get(child).emitOnSpawn = true;
    parent.registerEmissionSource({});
    parent.advanceFrames(1);
    assert.equal(child.particles.length, 1);
    parent.subSystems.get(child).emitOnSpawn = false;
    parent.registerEmissionSource({});
    parent.advanceFrames(1);
    assert.equal(child.particles.length, 1);
  } finally { parent.destroy(); }
});
