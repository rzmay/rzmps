import assert from 'node:assert/strict';
import * as THREE from 'three';
import { float } from 'three/tsl';
import {
  ColorBySize, ColorOverLifetime, Emitter, LimitVelocityOverLifetime,
  Module, Particle, ParticleSystem, ScaleBySpeed, ScaleOverLifetime,
  TrailRenderer, TransformByNoise, RotationOverLifetime, RotationBySize, RotationBySpeed, RotationByDepth,
} from '../build/index.mjs';

function birth(initialValues) {
  const emitter = new Emitter({ bursts: { time: 0, count: 1 }, initialValues });
  const particles = [];
  emitter.update(particles, { time: 0.25 }, new ParticleSystem({ renderers: [] }));
  return particles[0];
}

// Birth values normalize every dynamic leaf and store independent Three.js objects.
for (const color of ['#ff8844', 0xff8844, new THREE.Color('#ff8844')]) {
  const particle = birth({ color, scale: 2, scalarVelocity: 3, scalarAcceleration: 0 });
  assert.ok(particle.color instanceof THREE.Color);
  assert.ok(particle.color.equals(new THREE.Color('#ff8844')));
  assert.deepEqual(particle.scale.toArray(), [2, 2, 2]);
  assert.deepEqual(particle.scalarVelocity.toArray(), [3, 3, 3]);
  assert.deepEqual(particle.scalarAcceleration.toArray(), [0, 0, 0]);
}
const sharedColor = new THREE.Color('red');
const sharedScale = new THREE.Vector3(2, 3, 4);
const first = birth({ color: sharedColor, scale: sharedScale });
first.color.set('blue');
first.scale.setScalar(0);
assert.ok(sharedColor.equals(new THREE.Color('red')));
assert.deepEqual(sharedScale.toArray(), [2, 3, 4]);

const nested = birth({
  color: () => new Set([() => ['red', new THREE.Color('red')]]),
  scale: () => new Set([() => [2, new THREE.Vector3(2, 2, 2)]]),
});
assert.ok(nested.color.equals(new THREE.Color('red')));
assert.deepEqual(nested.scale.toArray(), [2, 2, 2]);

const particle = new Particle();
particle.time = 0.25;
new ScaleOverLifetime({ scale: (t) => 1 + t, scalarVelocity: [2, 2] }).modify([particle], 0);
assert.deepEqual(particle.scale.toArray(), [1.25, 1.25, 1.25]);
assert.deepEqual(particle.scalarVelocity.toArray(), [2, 2, 2]);
new ColorOverLifetime({ color: new Set(['red', 0xff0000]) }).modify([particle], 0);
assert.ok(particle.color.equals(new THREE.Color('red')));

// Mixed shorthand/object ranges and sets preserve seeded sampling and object inputs.
for (const [shortcut, explicit] of [
  [[1, new THREE.Vector3(3, 3, 3)], [new THREE.Vector3(1, 1, 1), new THREE.Vector3(3, 3, 3)]],
  [new Set([1, 3]), new Set([new THREE.Vector3(1, 1, 1), new THREE.Vector3(3, 3, 3)])],
]) {
  const a = new Particle();
  const b = new Particle();
  b.id = a.id;
  new ScaleOverLifetime({ scale: shortcut }).modify([a], 0);
  new ScaleOverLifetime({ scale: explicit }).modify([b], 0);
  assert.ok(a.scale.equals(b.scale));
}
const a = new Particle();
const b = new Particle();
b.id = a.id;
new ColorOverLifetime({ color: ['red', 0x0000ff] }).modify([a], 0);
new ColorOverLifetime({ color: [new THREE.Color('red'), new THREE.Color('blue')] }).modify([b], 0);
assert.ok(a.color.equals(b.color));

// Parameter ranges interpolate; direct values scale with the parameter; callbacks are explicit.
for (const [scale, expected] of [[4, 2], [[1, 3], 2], [() => 3, 3], [[() => 1, () => 3], 2]]) {
  const p = new Particle({ velocity: new THREE.Vector3(5, 0, 0) });
  new ScaleBySpeed({ speedRange: [0, 10], scale }).modify([p], 0);
  assert.deepEqual(p.scale.toArray(), [expected, expected, expected]);
}
for (const color of [['black', 'white'], () => '#bcbcbc', [() => 'black', () => 'white']]) {
  const p = new Particle({ scale: new THREE.Vector3(5, 0, 0) });
  new ColorBySize({ sizeRange: [0, 10], color }).modify([p], 0);
  const expected = typeof color === 'function' ? new THREE.Color('#bcbcbc') : new THREE.Color(0.5, 0.5, 0.5);
  assert.ok(p.color.equals(expected));
}
new TransformByNoise({ strength: 0 }).modify([new Particle()], 1);
const limited = new Particle({ velocity: new THREE.Vector3(3, -3, 2) });
new LimitVelocityOverLifetime({ limit: 1 }).modify([limited], 1);
assert.deepEqual(limited.velocity.toArray(), [1, -1, 1]);
const trail = new TrailRenderer({ texture: new THREE.Texture(), colorOverLifetime: 'red', colorOverTrail: () =>
  0xffffff });
assert.ok(trail);

// GPU stores normalize uniforms and callback samples, and retain bindings across shorthand/object edits.
const store = new Module(() => {}).gpuParameters;
let color = '#ff8844';
let scale = 2;
const colorNode = store.color('color', () => color, float(0.5));
const scaleNode = store.vector('scale', () => scale, float(0.5));
assert.ok(colorNode.value.equals(new THREE.Vector3(...new THREE.Color(color).toArray())));
assert.deepEqual(scaleNode.value.toArray(), [2, 2, 2]);
color = new THREE.Color('blue');
scale = new THREE.Vector3(3, 4, 5);
assert.equal(store.sync(), false);
assert.deepEqual(scaleNode.value.toArray(), [3, 4, 5]);
assert.deepEqual(colorNode.value.toArray(), [0, 0, 1]);
color = 0x000000;
scale = 0;
assert.equal(store.sync(), false);
assert.deepEqual(scaleNode.value.toArray(), [0, 0, 0]);
assert.deepEqual(colorNode.value.toArray(), [0, 0, 0]);
for (const value of [() => 2, [1, 3], new Set([1, 2]), () => [1, new THREE.Vector3(3, 3, 3)]]) {
  assert.doesNotThrow(() => store.vector(`vector${store.bindings.size}`, () => value, float(0.5)));
}
for (const value of [() => 'red', ['red', new THREE.Color('blue')], new Set(['red', 0x0000ff]), () => ['red',
  'blue']]) {
  assert.doesNotThrow(() => store.color(`color${store.bindings.size}`, () => value, float(0.5)));
}
assert.equal(store.sync(), false);
console.log('value shortcut tests passed');

// Angular shortcuts use the existing vector normalization path on birth and in every rotation module.
const rotatedBirth = birth({ rotation: 1.25, angularVelocity: -0.5, angularAcceleration: () => 0.2 });
assert.deepEqual(rotatedBirth.rotation.toArray(), [1.25, 1.25, 1.25]);
assert.deepEqual(rotatedBirth.angularVelocity.toArray(), [-0.5, -0.5, -0.5]);
assert.deepEqual(rotatedBirth.angularAcceleration.toArray(), [0.2, 0.2, 0.2]);
for (const value of [1, () => 1, [1, 1], new Set([1])]) {
  const p = new Particle();
  new RotationOverLifetime({ angle: value, angularVelocity: value, angularAcceleration: value }).modify([p], 0);
  for (const channel of ['rotation', 'angularVelocity', 'angularAcceleration']) {
    assert.deepEqual(p[channel].toArray(), [1, 1, 1]);
  }
}
for (const module of [
  new RotationBySize({ sizeRange: [0, 2], angle: [0, 4], angularVelocity: () => 3, angularAcceleration: [0, 2] }),
  new RotationBySpeed({ speedRange: [0, 10], angle: [0, 4], angularVelocity: () => 3, angularAcceleration: [0, 2] }),
  new RotationByDepth({ depthRange: [0, 10], angle: [0, 4], angularVelocity: () => 3, angularAcceleration: [0, 2] }),
]) {
  const p = new Particle({ scale: new THREE.Vector3(1, 0, 0), velocity: new THREE.Vector3(5, 0, 0),
    position: new THREE.Vector3(0, 0, 5) });
  module.modify([p], 0);
  assert.deepEqual(p.rotation.toArray(), [2, 2, 2]);
  assert.deepEqual(p.angularVelocity.toArray(), [3, 3, 3]);
  assert.deepEqual(p.angularAcceleration.toArray(), [1, 1, 1]);
}
const suppliedAngles = new THREE.Vector3(1, 2, 3);
const independentlyRotated = new Particle();
new RotationOverLifetime({ angle: suppliedAngles }).modify([independentlyRotated], 0);
independentlyRotated.rotation.setScalar(0);
assert.deepEqual(suppliedAngles.toArray(), [1, 2, 3]);
