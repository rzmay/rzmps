import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  DistortionByDepth,
  DistortionBySpeed,
  DistortionOverLifetime,
  Particle,
} from '../build/index.mjs';

/*
 * Checks:
 * - DistortionOverLifetime multiplies particle distortionStrength by time.
 * - DistortionBySpeed maps velocity length through speedRange.
 * - DistortionByDepth maps camera distance through depthRange.
 * - Distortion modules write particle distortionStrength for renderer upload.
 */

{
  const particle = new Particle({
    distortionStrength: 2,
  });
  const module = new DistortionOverLifetime({
    distortionStrength: (t) => 1 + 2 * t,
  });

  particle.time = 0.5;
  module.modify([particle], 0);

  assert.equal(particle.distortionStrength, 4);
}

{
  const particle = new Particle({
    distortionStrength: 2,
    velocity: new THREE.Vector3(5, 0, 0),
  });
  const module = new DistortionBySpeed({
    distortionStrength: [1, 3],
    speedRange: [0, 10],
  });

  module.modify([particle], 0);

  assert.equal(particle.distortionStrength, 4);
}

{
  const particle = new Particle({
    position: new THREE.Vector3(0, 0, 5),
    distortionStrength: 2,
  });
  const module = new DistortionByDepth({
    distortionStrength: [1, 3],
    depthRange: [0, 10],
  });

  module.modify([particle], 0);

  assert.equal(particle.distortionStrength, 4);
}
