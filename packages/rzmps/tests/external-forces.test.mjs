import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  ExternalForces,
  Particle,
} from '../build/index.mjs';

const particleSystem = {
  simulationSpace: 'world',
  updateWorldMatrix() {},
};

{
  const particle = new Particle({
    mass: 2,
    position: new THREE.Vector3(0, 0, 0),
  });
  const forces = new ExternalForces({
    forceFields: [
      {
        getForce(fieldParticle) {
          return fieldParticle.position.x < 1
            ? new THREE.Vector3(0, -4, 0)
            : new THREE.Vector3();
        },
      },
    ],
  });

  forces.prepare(particleSystem);
  forces.modify([particle], 0.5, particleSystem);

  assert.equal(particle.velocity.y, -1);
  assert.equal(particle.acceleration.y, 0);

  particle.position.x = 2;
  forces.modify([particle], 0.5, particleSystem);

  assert.equal(particle.velocity.y, -1);
  assert.equal(particle.acceleration.y, 0);
}

{
  const particle = new Particle({
    mass: 0,
    position: new THREE.Vector3(0, 0, 0),
  });
  const forces = new ExternalForces({
    forceFields: [
      {
        getForce() {
          return new THREE.Vector3(0, -4, 0);
        },
      },
    ],
  });

  forces.prepare(particleSystem);
  forces.modify([particle], 0.5, particleSystem);

  assert.equal(particle.velocity.y, -2);
  assert.equal(particle.acceleration.y, 0);
}
