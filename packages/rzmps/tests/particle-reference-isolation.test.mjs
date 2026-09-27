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
