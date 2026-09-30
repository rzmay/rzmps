import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  Module,
  Particle,
  ParticleSystem,
} from '../build/index.mjs';

/*
 * Checks:
 * - Priority 0..1 modules run before movement.
 * - Priority 0..1 changes affect the current movement step.
 * - Priority 0..1 changes do not persist across frames.
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
const preMovementVelocities = [];

const system = new ParticleSystem({
  emitters: [],
  modules: [
    new Module((p) => {
      p.mass += 1;
      p.velocity.x += 1;
      postMovementPositions.push(p.position.x);
      preMovementVelocities.push(p.velocity.x);
    }, { priority: Module.Priority.PreMovementTransient }),
    new Module((p) => {
      p.scale.multiplyScalar(2);
    }, { priority: Module.Priority.Transient }),
  ],
  renderers: [],
  gravityModifier: 0,
  looping: false,
});

system.particles.push(particle);
system.deltaTime = 1;

system._processParticles();

assert.equal(postMovementPositions[0], 0);
assert.equal(preMovementVelocities[0], 2);
assert.equal(particle.position.x, 2);
assert.equal(particle.mass, 2);
assert.equal(particle.scale.x, 2);

system._processParticles();

assert.equal(postMovementPositions[1], 2);
assert.equal(preMovementVelocities[1], 2);
assert.equal(particle.position.x, 4);
assert.equal(particle.mass, 2);
assert.equal(particle.scale.x, 2);
assert.equal(particle.start.scale.x, 1);
