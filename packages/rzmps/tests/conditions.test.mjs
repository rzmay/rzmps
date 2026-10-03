import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  Module,
  Particle,
  SpatialEffect,
} from '../build/index.mjs';

const createSystem = (scene = new THREE.Scene()) => ({
  scene,
  simulationSpace: 'world',
  cameraDistanceSq: 0,
  updateWorldMatrix() {},
});

{
  const accepted = new Particle({
    position: new THREE.Vector3(0, 0, 0),
    tags: ['accepted'],
  });
  const rejected = new Particle({
    position: new THREE.Vector3(0, 0, 0),
    tags: ['rejected'],
  });

  const module = new Module((particle) => {
    particle.alpha = 0.25;
  }, {
    condition: (particle) => particle.tags?.includes('accepted') ?? false,
  });

  module.modify([accepted, rejected], 0, createSystem());

  assert.equal(accepted.alpha, 0.25);
  assert.equal(rejected.alpha, 1);
}

{
  const accepted = new Particle({
    position: new THREE.Vector3(0, 0, 0),
    tags: ['accepted'],
  });
  const rejected = new Particle({
    position: new THREE.Vector3(0, 0, 0),
    tags: ['rejected'],
  });

  const effect = SpatialEffect.Sphere((particle) => {
    particle.alpha = 0.5;
  }, {
    condition: (particle) => particle.tags?.includes('accepted') ?? false,
  }, 2, 16, 8);

  effect.modify([accepted, rejected], 0, createSystem());

  assert.equal(accepted.alpha, 0.5);
  assert.equal(rejected.alpha, 1);
}
