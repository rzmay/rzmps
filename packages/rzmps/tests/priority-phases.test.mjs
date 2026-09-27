import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  Module,
  Particle,
  ParticleSystem,
} from '../build/index.mjs';

/*
 * Checks:
 * - Particle movement runs before priority 0..1 modules.
 * - Priority 0..1 module changes persist across frames.
 * - Priority >= 1 module changes are transient render-time changes.
 * - Transient changes do not mutate particle start values.
 */

const particle = new Particle({
  lifetime: 100,
  position: new THREE.Vector3(),
  velocity: new THREE.Vector3(1, 0, 0),
  scale: new THREE.Vector3(1, 1, 1),
  mass: 1,
});

const postMovementPositions = [];

const system = new ParticleSystem({
  emitters: [],
  modules: [
    new Module((p) => {
      p.mass += 1;
      postMovementPositions.push(p.position.x);
    }, { priority: 0.5 }),
    new Module((p) => {
      p.scale.multiplyScalar(2);
    }, { priority: 1 }),
  ],
  renderers: [],
  gravityModifier: 0,
  looping: false,
});

system.particles.push(particle);
system.deltaTime = 1;

system._processParticles();

assert.equal(postMovementPositions[0], 1);
assert.equal(particle.mass, 2);
assert.equal(particle.scale.x, 2);

system._processParticles();

assert.equal(postMovementPositions[1], 2);
assert.equal(particle.mass, 3);
assert.equal(particle.scale.x, 2);
assert.equal(particle.start.scale.x, 1);
