import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Particle } from '../build/index.mjs';

/*
 * Checks:
 * - Particle clones constructor position values.
 * - Particle clones constructor scale values.
 * - Particle clones constructor color values.
 * - Mutating one particle does not mutate caller-owned values or sibling particles.
 */

const sharedScale = new THREE.Vector3(2.5, 2.5, 2.5);
const sharedColor = new THREE.Color('#ff8844');
const sharedPosition = new THREE.Vector3(1, 2, 3);

const a = new Particle({
  position: sharedPosition,
  scale: sharedScale,
  color: sharedColor,
});
const b = new Particle({
  position: sharedPosition,
  scale: sharedScale,
  color: sharedColor,
});

a.scale.multiplyScalar(1.3);
a.color.multiplyScalar(0.5);
a.position.x = 100;

assert.equal(sharedScale.x, 2.5);
assert.equal(sharedColor.r, new THREE.Color('#ff8844').r);
assert.equal(sharedPosition.x, 1);

assert.equal(b.scale.x, 2.5);
assert.equal(b.color.r, new THREE.Color('#ff8844').r);
assert.equal(b.position.x, 1);

// Render-only shallow clones share inherited references and use overrides directly.
a.cache();
const replacementPosition = new THREE.Vector3(4, 5, 6);
const replacementColor = new THREE.Color('blue');
const alias = a.shallowClone('alias', { position: replacementPosition, color: replacementColor, alpha: 0.25 });
assert.ok(alias instanceof Particle);
assert.equal(alias.id, 'alias');
assert.equal(alias.position, replacementPosition);
assert.equal(alias.color, replacementColor);
assert.equal(alias.scale, a.scale);
assert.equal(alias.rotation, a.rotation);
assert.equal(alias.velocity, a.velocity);
assert.equal(alias.tags, a.tags);
assert.equal(alias.noise, a.noise);
assert.equal(alias.data, a.data);
assert.equal(alias.start, a.start);
assert.equal(alias.alpha, 0.25);
assert.notEqual(a.alpha, alias.alpha);
alias.position.x = 999;
assert.equal(a.position.x, 100);
assert.equal(a.color.r, new THREE.Color('#ff8844').r * 0.5);
const deep = alias.clone();
assert.notEqual(deep.position, alias.position);
assert.notEqual(deep.scale, alias.scale);
assert.notEqual(deep.color, alias.color);
assert.deepEqual(deep.position.toArray(), alias.position.toArray());
const unchanged = a.shallowClone('unchanged');
assert.equal(unchanged.position, a.position);
assert.equal(unchanged.lodPriority, a.lodPriority);
assert.equal(unchanged.startTime, a.startTime);
class CustomParticle extends Particle {
  label() { return this.id; }
}
const custom = new CustomParticle().shallowClone('custom');
assert.ok(custom instanceof CustomParticle);
assert.equal(custom.label(), 'custom');

// Full clones retain current-state birth snapshots and independent mutable attributes.
const original = new Particle({ tags: ['original'], position: new THREE.Vector3(1, 2, 3) });
original.cache();
original.position.x = 8;
original.alpha = 0.4;
original.time = 0.5;
original.realtime = 500;
original.startTime = 123;
original.alive = false;
original.lodPriority = 0.2;
original.parent = a;
original.noise.sample = { noise: 1, noise4d: 2 };
original.data.nested = { retained: true };
const copy = original.clone();
for (const key of [
  'position', 'orbitCenter', 'rotation', 'scale', 'velocity', 'angularVelocity',
  'scalarVelocity', 'acceleration', 'angularAcceleration', 'scalarAcceleration', 'color',
]) {
  assert.notEqual(copy[key], original[key], `${key} must be independent`);
  assert.deepEqual(copy[key].toArray(), original[key].toArray());
  assert.notEqual(copy.start[key], copy[key], `${key} start values must be independent`);
  assert.notEqual(copy.start[key], original.start[key]);
  assert.deepEqual(copy.start[key].toArray(), original[key].toArray());
}
for (const key of ['id', 'time', 'realtime', 'startTime', 'alive', 'lodPriority', 'parent']) {
  assert.equal(copy[key], original[key]);
}
assert.notEqual(copy.tags, original.tags);
assert.notEqual(copy.start.tags, copy.tags);
assert.deepEqual(copy.tags, original.tags);
assert.notEqual(copy.noise, original.noise);
assert.equal(copy.noise.sample, original.noise.sample);
assert.notEqual(copy.data, original.data);
assert.equal(copy.data.nested, original.data.nested);
copy.restore();
assert.equal(copy.position.x, 8, 'the source cache must not leak into a clone');
assert.equal(copy.alpha, 0.4);
copy.position.x = 99;
copy.tags[0] = 'copy';
assert.equal(original.position.x, 8);
assert.equal(copy.start.position.x, 8);
assert.deepEqual(original.tags, ['original']);
