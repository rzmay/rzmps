import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  Emitter,
  Particle,
  ParticleSystem,
} from '../build/index.mjs';

/*
 * Checks:
 * - rateOverDistance does not emit on the first frame because no prior position exists.
 * - rateOverDistance accumulates fractional distance credit between frames.
 * - rateOverDistance uses the parent particle position for continuous subsystems.
 * - rateOverDistance can emit subsystem particles while normal time-based rate is zero.
 */

const system = new ParticleSystem({
  renderers: [],
});
const emitter = new Emitter({
  rate: 0,
  rateOverDistance: 2,
  radialSpeed: 0,
  initialValues: {
    lifetime: 1,
  },
});
const particles = [];

emitter.update(particles, {
  position: new THREE.Vector3(0, 0, 0),
  time: 0,
}, system);
assert.equal(particles.length, 0);

emitter.update(particles, {
  position: new THREE.Vector3(0.49, 0, 0),
  time: 0,
}, system);
assert.equal(particles.length, 0);

emitter.update(particles, {
  position: new THREE.Vector3(0.51, 0, 0),
  time: 0,
}, system);
assert.equal(particles.length, 1);

emitter.update(particles, {
  position: new THREE.Vector3(1.51, 0, 0),
  time: 0,
}, system);
assert.equal(particles.length, 3);

const parent = new ParticleSystem({
  renderers: [],
});
const child = new ParticleSystem({
  renderers: [],
  emitters: new Emitter({
    rate: 0,
    rateOverDistance: 5,
    radialSpeed: 0,
    initialValues: {
      lifetime: 1,
    },
  }),
});
const parentParticle = new Particle({
  lifetime: 10,
  position: new THREE.Vector3(0, 0, 0),
});

parent.addSubSystem(child, {
  inheritScale: 0,
  inheritVelocity: 0,
});
parent.particles.push(parentParticle);
parent.deltaTime = 1 / 60;
parent._updateSubSystems();
assert.equal(child.particles.length, 0);

parentParticle.position.z = -1;
parent._updateSubSystems();
assert.equal(child.particles.length, 5);
