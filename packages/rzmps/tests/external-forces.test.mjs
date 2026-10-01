import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  ExternalForces,
  Particle,
} from '../build/index.mjs';

/*
 * Checks:
 * - Force fields apply force directly to velocity during the current step.
 * - Force application divides by particle mass when mass is nonzero.
 * - Leaving a force field does not leave stale acceleration on the particle.
 * - Massless particles preserve the old acceleration-field-style behavior.
 * - Force field helpers are exposed under ExternalForces.
 * - Inverted force fields apply outside their shape instead of inside.
 */

assert.equal(typeof ExternalForces.ParticleForceField, 'function');
assert.equal(typeof ExternalForces.ParticleForceFieldHelper, 'function');
assert.ok(ExternalForces.ParticleForceField.Sphere() instanceof ExternalForces.ParticleForceField);

const particleSystem = {
  simulationSpace: 'world',
  updateWorldMatrix() { },
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
  const inside = new Particle({
    mass: 1,
    position: new THREE.Vector3(0, 0, 0),
  });
  const outside = new Particle({
    mass: 1,
    position: new THREE.Vector3(3, 0, 0),
  });
  const invertedField = ExternalForces.ParticleForceField.Sphere({
    inverted: true,
    gravity: 2,
  }, 1, 16, 8);
  const forces = new ExternalForces({
    forceFields: [invertedField],
  });

  forces.prepare(particleSystem);
  forces.modify([inside, outside], 1, particleSystem);

  assert.equal(inside.velocity.length(), 0);
  assert.ok(outside.velocity.x < 0);
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
