import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  ColorBySize,
  DistortionBySize,
  MassBySize,
  Particle,
  SpeedBySize,
} from '../build/index.mjs';

/*
 * Checks:
 * - Size-driven modules are exported from the public API.
 * - ColorBySize maps particle scale length through sizeRange for alpha.
 * - DistortionBySize maps particle scale length for distortionStrength.
 * - MassBySize maps particle scale length for mass.
 * - SpeedBySize maps particle scale length for speed.
 */

const particle = new Particle({
  alpha: 1,
  color: new THREE.Color(1, 1, 1),
  distortionStrength: 2,
  mass: 2,
  scale: new THREE.Vector3(5, 0, 0),
  speed: 2,
});

new ColorBySize({
  alpha: [1, 3],
  sizeRange: [0, 10],
}).modify([particle], 0);

new DistortionBySize({
  distortionStrength: [1, 3],
  sizeRange: [0, 10],
}).modify([particle], 0);

new MassBySize({
  mass: [1, 3],
  sizeRange: [0, 10],
}).modify([particle], 0);

new SpeedBySize({
  speed: [1, 3],
  sizeRange: [0, 10],
}).modify([particle], 0);

assert.equal(particle.alpha, 2);
assert.equal(particle.distortionStrength, 4);
assert.equal(particle.mass, 4);
assert.equal(particle.speed, 4);
