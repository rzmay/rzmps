import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { SurfaceAttachment, ParticleSystem, Particle, Module, FLIPSimulation } from '../../../build/index.mjs';

function system(module) {
  return new ParticleSystem({ gpuProcessing: false, emitters: [], renderers: [], modules: [module],
    gravityModifier: 0, substep: false });
}
const close = (actual, expected, tolerance = 1e-5) => assert(Math.abs(actual - expected) < tolerance,
  `${actual} should be close to ${expected}`);

test('static CPU mesh attachment persists after integration and preserves tangential sliding', () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
  const attachment = new SurfaceAttachment({ surface: mesh, offset: 0.05, adhesion: 1000, tangentialDrag: 0 });
  const owner = system(attachment);
  const particle = new Particle({ position: new THREE.Vector3(0, 1.2, 0),
    velocity: new THREE.Vector3(1, -1, 0), lifetime: 10 });
  owner.addParticle(particle);
  owner.advanceFrames(1, 0.1);
  close(particle.position.y, 1.05); close(particle.position.x, 0.1);
  close(particle.velocity.y, 0); close(particle.velocity.x, 1);
  owner.advanceFrames(1, 0.1);
  close(particle.position.y, 1.05); close(particle.position.x, 0.2);
  owner.destroy(); mesh.geometry.dispose();
});

test('transform-derived CPU velocity includes rigid translation and rotation', () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
  const attachment = new SurfaceAttachment({ surface: mesh, adhesion: 1000, tangentialDrag: 100 });
  const owner = system(attachment);
  const particle = new Particle({ position: new THREE.Vector3(0.5, 1, 0), lifetime: 10 });
  owner.addParticle(particle); owner.advanceFrames(1, 0.1);
  mesh.position.y = 0.25;
  owner.advanceFrames(1, 0.1);
  close(particle.position.y, 1.25); close(particle.velocity.y, 2.5);
  // The same material point rotates around the object's origin. Rotation is not translation-only velocity.
  mesh.rotation.y = Math.PI / 6;
  owner.advanceFrames(1, 0.1);
  assert(Math.abs(particle.velocity.z) > 1);
  owner.destroy(); mesh.geometry.dispose();
});

test('CPU override supports invalid/distant detachment and tagged constraints with transient state', () => {
  let valid = true;
  const attachment = new SurfaceAttachment({ sampler: p => ({ distance: p.y, normal: new THREE.Vector3(0, 1, 0),
    velocity: new THREE.Vector3(2, 0, 0), valid }), adhesion: 1000, tangentialDrag: 2,
  detachDistance: 0.5, tags: 'foam', killOnDetach: true });
  const transient = new Module(p => { p.velocity.x += 1; }, { priority: Module.Priority.PreMovementTransient });
  const owner = system(attachment); owner.modules.push(transient);
  const particle = new Particle({ position: new THREE.Vector3(0, 0.1, 0), tags: ['foam'], lifetime: 10 });
  owner.addParticle(particle); owner.advanceFrames(2, 0.1);
  close(particle.position.y, 0);
  assert(particle.velocity.x > 0 && particle.velocity.x < 2);
  valid = false; owner.advanceFrames(1, 0.1);
  assert.equal(owner.particles.length, 0);
  owner.destroy();
  assert.equal(attachment.supportsGPU, false, 'CPU-only overrides select the CPU path');
});

test('foam and spray use ordinary independent subsystem conditions', () => {
  const foam = FLIPSimulation.FoamCondition(), spray = FLIPSimulation.SprayCondition();
  assert.equal(typeof foam, 'function'); assert.equal(typeof spray, 'function');
  assert(foam.spatialGridOptions); assert(spray.spatialGridOptions);
  assert.throws(() => FLIPSimulation.FoamCondition({ minimumNeighbors: 10, maximumNeighbors: 3 }), /neighbor/);
  assert.throws(() => FLIPSimulation.FoamCondition({ minimumDeformity: -1 }), /minimumDeformity/);
  assert.throws(() => FLIPSimulation.FoamCondition({ minimumDeformity: 0.5 }), /samplerGPU/);
});
