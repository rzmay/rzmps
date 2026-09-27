import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  Emitter,
  Particle,
  ParticleSystem,
} from '../build/index.mjs';

/*
 * Checks:
 * - Subsystem inheritVelocity adds a numeric fraction of parent velocity.
 * - Subsystem inheritColor blends parent color with child particle color.
 * - Subsystem inheritAlpha blends parent alpha with child particle alpha.
 * - Subsystem inheritMass adds a numeric fraction of parent mass.
 */

const parent = new ParticleSystem({
  renderers: [],
});
const child = new ParticleSystem({
  renderers: [],
  emitters: new Emitter({
    rate: 0,
    radialSpeed: 0,
    bursts: [{ time: 0, count: 1 }],
    initialValues: {
      lifetime: 1,
      velocity: new THREE.Vector3(1, 2, 3),
      color: new THREE.Color(1, 1, 1),
      alpha: 1,
      mass: 2,
    },
  }),
});

parent.addSubSystem(child, {
  inheritColor: 0.5,
  inheritAlpha: 0.25,
  inheritMass: 0.5,
  inheritVelocity: 0.5,
});

parent.particles.push(new Particle({
  lifetime: 1,
  color: new THREE.Color(1, 0, 0),
  alpha: 0.2,
  mass: 4,
  velocity: new THREE.Vector3(10, 0, 0),
}));
parent.deltaTime = 1 / 60;

parent._updateSubSystems();

assert.equal(child.particles.length, 1);
assert.equal(child.particles[0].velocity.x, 6);
assert.equal(child.particles[0].velocity.y, 2);
assert.equal(child.particles[0].velocity.z, 3);
assert.equal(child.particles[0].color.r, 1);
assert.equal(child.particles[0].color.g, 0.5);
assert.equal(child.particles[0].color.b, 0.5);
assert.equal(child.particles[0].alpha, 0.8);
assert.equal(child.particles[0].mass, 5);
