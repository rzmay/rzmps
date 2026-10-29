import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { Fn, vec4, uint } from 'three/tsl';
import { ParticleSystem, Particle, Emitter, EmissionShape, RegisteredEmissionSource,
  GPUEventBufferState, GPU_EVENT_FLOAT_SLOT_COUNT, createEmptyGPUParticleBufferState,
  DecalRenderer } from '../build/index.mjs';

const root = () => new ParticleSystem({ emitters: [], renderers: [], gravityModifier: 0 });
function pointShape() {
  const shape = new EmissionShape({ source: 'vertices', geometry: new THREE.PlaneGeometry(1, 1) });
  shape.getPoint = () => ({ position: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0) });
  return shape;
}
const effect = (options = {}) => new ParticleSystem({ duration: 1, looping: true, gravityModifier: 0,
  emitters: new Emitter({ source: pointShape(), bursts: { time: 0, count: 1 },
    radialSpeed: 0, initialValues: { lifetime: 20 }, ...options }), renderers: [] });
const frame = (system, dt = 0.1) => { system.deltaTime = dt; system._updateSubSystems(); };
const origin = (system, data = {}) => system.registerEmissionSource({ transform: new THREE.Matrix4(), ...data });

test('GPU tag helpers resolve names, preserve unrelated bits and reject unregistered tags', () => {
  const system = root();
  const tags = Array.from({ length: 32 }, (_, index) => `tag-${index}`);
  system._prepareGPUTagRegistry(tags.map(tag => ({ tags: [tag] })));
  let mask = 2;
  const particle = { tagMask: {
    bitOr: node => (mask | node.node.value) >>> 0,
    bitAnd: node => (mask & node.node.value) >>> 0,
    assign: value => { mask = value; },
  } };
  system._applyGPUModifiers([], particle, {});
  particle.addTag('tag-31');
  particle.addTag('tag-31');
  assert.equal(mask, 0x80000002);
  particle.addTag('tag-0');
  assert.equal(mask, 0x80000003);
  particle.removeTag('tag-31');
  particle.removeTag('tag-31');
  assert.equal(mask, 3);
  particle.removeTag('tag-0');
  assert.equal(mask, 2);
  assert.throws(() => particle.addTag('typo'), /not registered/);
  assert.throws(() => particle.removeTag('typo'), /not registered/);
  assert.equal(mask, 2);
  system.destroy();
});

test('persistent handles use a distinct namespace, copy input, delegate, and never simulate placeholders', () => {
  const system = root(), matrix = new THREE.Matrix4().makeTranslation(1, 2, 3);
  const source = origin(system, { transform: matrix, tags: ['pool'] });
  assert.ok(source instanceof RegisteredEmissionSource);
  assert.match(source.id, /^source:/);
  assert.equal(system.particles.length, 0);
  matrix.makeTranslation(100, 0, 0);
  assert.equal(source.position.x, 1);
  assert.equal(source.update({ alpha: 0.5 }), source);
  assert.equal(source.data.alpha, 0.5);
  const snapshot = source.data;
  snapshot.transform.identity();
  assert.equal(source.position.x, 1);
  const id = source.id;
  frame(system, 0.5);
  assert.equal(source.realtime, 500);
  system.updateSource(id, { alpha: 0.25 });
  assert.equal(source.id, id);
  assert.equal(source.realtime, 500);
  source.dispose(); source.dispose();
  assert.equal(system._emissionSources.size, 0);
  system.destroy();
});

test('registration/death dispatch once, tag filtering, ratio and predicate select both source types', () => {
  const system = root(), child = effect();
  const selected = [];
  system.addSubSystem(child, { emitOnSpawn: true, emitOnDeath: true, tags: ['pool'],
    shouldEmit: p => { selected.push(p.id); return p.alpha > 0; } });
  origin(system, { tags: ['other'] });
  const source = origin(system, { tags: ['pool'] });
  frame(system);
  assert.equal(child.particles.length, 1);
  const p = new Particle({ tags: ['pool'] }); system.addParticle(p); system._notifySpawn(p);
  frame(system);
  assert.equal(child.particles.length, 2);
  source.dispose(); source.dispose(); frame(system);
  assert.equal(child.particles.length, 3);
  assert.equal(selected.filter(id => id === source.id).length, 2);
  assert.equal(child.emitters[0]._contextStates.has(source.id), false);
  system.subSystems.get(child).ratio = 0;
  origin(system, { tags: ['pool'] }); frame(system);
  assert.equal(child.particles.length, 3);
  system.destroy();
});

test('source movement retains distance credit and continuous state, loops and child survival', () => {
  const system = root(), child = effect({ rate: 0, rateOverDistance: 2, bursts: [] });
  system.addSubSystem(child, { emitContinuous: true, inheritLifetime: 0 });
  const source = origin(system);
  frame(system);
  const state = child.emitters[0]._contextStates.get(source.id);
  source.update({ transform: new THREE.Matrix4().makeTranslation(0.2, 0, 0) }); frame(system);
  assert.equal(child.particles.length, 0);
  source.update({ transform: new THREE.Matrix4().makeTranslation(0.6, 0, 0) }); frame(system);
  assert.equal(child.particles.length, 1);
  assert.equal(child.emitters[0]._contextStates.get(source.id), state);
  source.dispose(); frame(system);
  assert.equal(child.particles.length, 1);
  assert.equal(child.emitters[0]._contextStates.size, 0);
  system.destroy();
});

test('CPU payloads and context overrides freeze at dispatch and never mutate source state', () => {
  const system = root(), child = effect();
  let calls = 0;
  system.addSubSystem(child, { onEvent: { bubble: (data, source, context) => {
    calls++;
    context.color.set('red');
    return { scale: data.strength, position: new THREE.Vector3(data.x, 2, 3), alpha: 0.4,
      velocity: new THREE.Vector3(1, 2, 3) };
  } } });
  const source = origin(system);
  source.emitEvent('bubble', { strength: 3, x: 5 });
  source.update({ transform: new THREE.Matrix4().makeTranslation(99, 0, 0) });
  frame(system);
  assert.equal(calls, 1);
  const p = child.particles[0];
  assert.equal(p.scale.x, 3);
  assert.equal(p.position.x, 5.1);
  assert.equal(p.alpha, 0.4);
  assert.equal(source.color.r, 1);
  assert.equal(source.color.g, 1);
  assert.equal(source.position.x, 99);
  const particle = new Particle(); system.addParticle(particle);
  particle.emitEvent('bubble', { strength: 2, x: 8 }); frame(system);
  assert.equal(calls, 2);
  assert.equal(child.particles.at(-1).scale.x, 2);
  // Clone and visual views must not retain an owning dispatcher.
  particle.clone().emitEvent('bubble', {});
  particle.shallowClone('view').emitEvent('bubble', {});
  assert.equal(calls, 2);
  system.destroy();
});

test('legacy and named built-in subscriptions create one run; source death runs finish after disposal', () => {
  const system = root(), child = effect({ bursts: [{ time: 0, count: 1 }, { time: 0.5, count: 1 }] });
  let calls = 0;
  system.addSubSystem(child, { emitOnDeath: true, onEvent: { death: () => { calls++; return { scale: 2 }; } } });
  const source = origin(system); source.dispose(); frame(system);
  assert.equal(child.particles.length, 1);
  assert.equal(calls, 1);
  frame(system, 0.5);
  assert.equal(child.particles.length, 2);
  frame(system, 1);
  assert.equal(child._emissionRuns.length, 0);
  assert.equal(child.emitters[0]._contextStates.size, 0);
  system.destroy();
});

test('continuous sources share numeric inheritance and nested event behavior', () => {
  const system = root(), child = effect(), nested = effect();
  system.addSubSystem(child, { inheritColor: 0.5, inheritAlpha: 0.5, inheritVelocity: 0.5,
    inheritScale: 0.5, inheritMass: 0.5, inheritLifetime: 0 });
  child.addSubSystem(nested, { emitOnSpawn: true });
  origin(system, { color: new THREE.Color(0, 0, 0), alpha: 0, mass: 3, velocity: new THREE.Vector3(2, 0, 0) });
  frame(system);
  assert.equal(child.particles[0].color.r, 0.5);
  assert.equal(child.particles[0].alpha, 0.5);
  assert.equal(child.particles[0].velocity.x, 1);
  assert.equal(nested.particles.length, 1);
  system.destroy();
});

test('automatic discovery includes gpu-only events, preserves built-in IDs, and diagnoses limits', () => {
  const system = root();
  system.addSubSystem(effect(), { onEvent: { gpu: { hot: () => ({}) }, cold: true } });
  assert.deepEqual([...system._eventTypes], [['death', 1], ['spawn', 2], ['collision', 3], ['cold', 4], ['hot', 5]]);
  const before = [...system._eventTypes];
  origin(system).emitEvent('undiscovered');
  assert.deepEqual([...system._eventTypes], before);
  assert.throws(() => system.addSubSystem(effect(), { onEvent: Array.from({ length: 30 }, (_, i) =>
    `event${i}`) }), /32 event types/);
  system.destroy();
});

test('GPU event ABI retains 15 vec4 slots, full payloads, distinct records, snapshots and generation IDs', async () => {
  assert.equal(GPU_EVENT_FLOAT_SLOT_COUNT, 15);
  const buffer = new GPUEventBufferState(2);
  buffer.reset(7);
  buffer.counterAttribute.array.set([3, 1]);
  const floats = buffer.floatAttribute.array;
  const uints = new Uint32Array(floats.buffer);
  for (let i = 0; i < 2; i++) {
    const base = i * 60;
    floats[base] = 5 + i;
    floats.set(Array.from({ length: 12 }, (_, k) => k + 1 + i * 20), base + 44);
    uints.set([4 + i, 9, 123, 0], base + 56);
  }
  const batch = await buffer.readback({ getArrayBufferAsync: async attribute => attribute.array.buffer.slice(0) },
    () => undefined);
  assert.equal(batch.events.length, 2);
  assert.equal(batch.overflowCount, 1);
  assert.equal(batch.events[0].particle.id, 'gpu:9:123');
  assert.equal(batch.events[0].particle.position.x, 5);
  assert.deepEqual(batch.events[0].data.flatMap(v => v.toArray()), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.equal(batch.events[1].type, 5);
});

test('GPU writer validates payload capacity while building the TSL graph', () => {
  const buffer = new GPUEventBufferState(4), particles = createEmptyGPUParticleBufferState(1);
  const build = data => Fn(() => buffer.createWriter().emitParticleEvent(4,
    particles.storage.createParticle(uint(0), true), data))();
  assert.throws(() => buffer.createWriter().emitParticleEvent(4, particles.storage.createParticle(uint(0), true),
    [vec4(1), vec4(2), vec4(3), vec4(4)]), /three vec4/);
  assert.ok(build(vec4(1)));
  assert.ok(build([vec4(1), vec4(2), vec4(3)]));
});

test('tagged decals expose sources, follow rigid surface motion and fade, and clean up on eviction', () => {
  const renderer = new DecalRenderer(new THREE.MeshBasicMaterial(), { emissionTags: ['pool'], maxDecals: 1,
    lifetime: 2, opacity: t => 1 - t });
  const system = root(); system.addRenderer(renderer);
  const scene = new THREE.Scene(), floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20),
    new THREE.MeshBasicMaterial());
  floor.rotation.x = -Math.PI / 2; scene.add(floor, system); scene.updateMatrixWorld(true);
  const spawn = () => system._notifySpawn(new Particle({ position: new THREE.Vector3(0, 1, 0) }));
  spawn();
  const first = renderer.decals[0].source;
  assert.ok(first);
  assert.ok(new THREE.Vector3(0, 1, 0).transformDirection(first.transform).y > 0.99);
  floor.position.x = 3;
  renderer.update([], system, 0.5);
  assert.ok(Math.abs(first.position.x - 3) < 1e-6);
  assert.equal(first.alpha, 0.75);
  spawn();
  assert.equal(first.alive, false);
  assert.equal(system._emissionSources.size, 1);
  renderer.update([], system, 3);
  assert.equal(system._emissionSources.size, 0);
  system.destroy();
});

test('GPU-origin numerical payloads reach CPU callbacks in frame order after particle death', () => {
  const system = root(), child = effect();
  const delivered = [];
  system.addSubSystem(child, { onEvent: { hot: (data, source) => {
    delivered.push([source.id, data[0].x]); return { scale: data[0].x };
  } } });
  const dead = new Particle({ position: new THREE.Vector3(3, 4, 5) });
  dead.id = 'gpu:7:9'; dead.alive = false;
  const batch = sequence => ({ sequence, events: [{ type: system._eventTypes.get('hot'), slot: 7, generation: 9,
    particle: dead.clone(), data: [new THREE.Vector4(sequence, 0, 0, 0), new THREE.Vector4(), new THREE.Vector4()] }],
    overflowCount: 0, rawEventCount: 1, capacity: 10 });
  system._gpuCompletedEventBatches.set(2, batch(2)); system._flushGPUEventBatches();
  assert.equal(delivered.length, 0);
  system._gpuCompletedEventBatches.set(1, batch(1)); system._flushGPUEventBatches(); frame(system);
  assert.deepEqual(delivered, [['gpu:7:9', 1], ['gpu:7:9', 2]]);
  assert.deepEqual(child.particles.map(p => p.scale.x).sort(), [1, 2]);
  system.destroy();
});

test('external GPU targeting batches snapshots without coalescing events and rejects recycled generations',
  async () => {
  const system = root(), child = effect(); let calls = 0;
  system.addSubSystem(child, { onEvent: { hot: () => { calls++; } } });
  system._isGPUProcessingActive = true;
  system._gpuBuffers = createEmptyGPUParticleBufferState(16);
  const snapshot = new Particle(); snapshot.id = 'gpu:7:9';
  let requests;
  system._readbackGPUParticles = async r => { requests = r; return [{ slot: 7, generation: 9, valid: true,
    particle: snapshot }]; };
  system.emitEvent('gpu:7:9', 'hot'); system.emitEvent('gpu:7:9', 'hot');
  system.emitEvent('gpu:7:8', 'hot');
  system._flushTargetedGPUEvents(); await Promise.resolve();
  assert.equal(requests.length, 2, 'one gather per identity, retaining every dispatch');
  assert.equal(calls, 2, 'the old generation cannot receive a newer snapshot');
  system.destroy();
});

test('source updates preserve simulation-clock loops and independent burst progression', () => {
  const system = root(), child = effect({ bursts: [{ time: 0, count: 1 }, { time: 0.5, count: 1 }] });
  system.addSubSystem(child, { emitContinuous: true, inheritLifetime: 0 });
  const source = origin(system);
  frame(system, 0.1); assert.equal(child.particles.length, 1);
  source.update({ alpha: 0.8 }); frame(system, 0.5); assert.equal(child.particles.length, 2);
  source.update({ alpha: 0.6 }); frame(system, 0.5); assert.equal(child.particles.length, 3);
  source.dispose(); assert.equal(child.emitters[0]._contextStates.size, 0);
  system.destroy();
});

test('returned mutable context overrides are captured independently of subsequent source changes', () => {
  const system = root(), child = effect();
  system.addSubSystem(child, { onEvent: { hot: (_, source) => ({ velocity: source.velocity, color: source.color }) } });
  const source = origin(system, { velocity: new THREE.Vector3(2, 0, 0), color: new THREE.Color('red') });
  source.emitEvent('hot');
  source.update({ velocity: new THREE.Vector3(9, 0, 0), color: new THREE.Color('blue') });
  frame(system);
  assert.equal(child.particles[0].velocity.x, 2);
  assert.equal(child.particles[0].color.r, 1);
  assert.equal(child.particles[0].color.b, 0);
  system.destroy();
});

test('explicit registered collision events preserve impulse rules and capture collision payloads', () => {
  const system = root(), child = effect({ bursts: [{ time: 0, count: 1 }, { time: 0.5, count: 1 }] });
  system.addSubSystem(child, { emitOnCollision: true, impulseThreshold: 1, impulseAffectsScale: 1 });
  const source = origin(system);
  const hit = { point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0), impulse: new THREE.Vector3(0, 2, 0) };
  source.emitEvent('collision', hit); hit.impulse.set(0, 8, 0);
  frame(system);
  assert.equal(child.particles[0].scale.x, 2);
  frame(system, 0.5);
  assert.equal(child.particles.at(-1).scale.x, 2);
  source.emitEvent('collision', { ...hit, impulse: new THREE.Vector3(0, 0.5, 0) });
  assert.equal(child._emissionRuns.length, 1);
  system.destroy();
});

test('GPU particles feed CPU continuous predicates through snapshots and release missing contexts', async () => {
  const system = root(), child = effect();
  child.gpuProcessing = false;
  system.addSubSystem(child, { emitContinuous: true, shouldEmit: p => p.alpha > 0.5 });
  system._isGPUProcessingActive = true;
  system._gpuBuffers = createEmptyGPUParticleBufferState(2);
  system._gpuBuffers.ensureCount(2);
  const snapshot = new Particle({ alpha: 1 }); snapshot.id = 'gpu:0:4';
  let alive = true;
  system._readbackGPUParticles = async () => [{ slot: 0, generation: 4, valid: alive, particle: snapshot }];
  system._readGPUContinuousSources(); await Promise.resolve(); await Promise.resolve();
  frame(system);
  assert.equal(child.particles.length, 1);
  assert.ok(child.emitters[0]._contextStates.has(snapshot.id));
  await Promise.resolve(); await Promise.resolve(); alive = false;
  system._readGPUContinuousSources(); await Promise.resolve(); await Promise.resolve();
  assert.equal(child.emitters[0]._contextStates.has(snapshot.id), false);
  assert.equal(child.particles.length, 1);
  system.destroy();
});

test('normal root updates refresh owned subsystem cubemaps once; offline steps do not capture', () => {
  const system = root(), child = root(), nested = root();
  system.gpuProcessing = child.gpuProcessing = nested.gpuProcessing = false;
  system.addSubSystem(child, {});
  child.addSubSystem(nested, {});
  child.useLiveCubemap = nested.useLiveCubemap = true;
  const captures = [];
  child.liveCubemap.update = () => captures.push('child');
  nested.liveCubemap.update = () => captures.push('nested');
  system.lastFrame = Date.now() - 16;
  system.update(); child.update(); nested.update();
  assert.deepEqual(captures, ['child', 'nested']);
  system.advanceFrames(1, 0.1);
  assert.equal(captures.length, 2);
  system.pause(); system.update();
  assert.equal(captures.length, 2);
  system.destroy();
});

test('emitter shape offsets are sampled before source translation, rotation and scale', () => {
  const system = root();
  const shape = EmissionShape.Box({ source: 'vertices' }, 2, 2, 2);
  shape.scale.set(0.5, 0.1, 0.5);
  const child = effect({ source: shape });
  system.addSubSystem(child, { emitOnSpawn: true, inheritScale: 1 });
  const transform = new THREE.Matrix4().compose(new THREE.Vector3(4, 5, 6),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2),
    new THREE.Vector3(2, 2, 2));
  origin(system, { transform }); frame(system);
  const position = child.particles[0].position;
  assert.ok(Math.abs(Math.abs(position.x - 4) - 0.2) < 1e-6);
  assert.ok(Math.abs(Math.abs(position.y - 5) - 1) < 1e-6);
  assert.ok(Math.abs(Math.abs(position.z - 6) - 1) < 1e-6);
  system.destroy();
});
