const context = {
  system: new ParticleSystem({ emitters: [], modules: [], renderers: [] }),
  deltaTime: 0,
  events: Object.freeze([]),
};

import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  ColorByDepth,
  Particle,
  ParticleSystem,
} from '../build/index.mjs';

/*
 * Checks:
 * - Particles before a depthRange clamp to the near value instead of fading out.
 * - ColorByDepth alpha uses ValueByParameter interpolation within depthRange.
 * - Multiple depth-driven alpha modules multiply together in the same frame.
 */

{
  const particle = new Particle({
    position: new THREE.Vector3(0, 0, 5),
    alpha: 1,
  });
  const fadeOut = new ColorByDepth({
    alpha: [1, 0.5],
    depthRange: [6, 24],
  });

  fadeOut.modify([particle], 0, context);

  assert.equal(particle.alpha, 1);
}

{
  const particle = new Particle({
    position: new THREE.Vector3(0, 0, 0.5),
    alpha: 1,
  });
  const fadeOut = new ColorByDepth({
    alpha: [1, 0.5],
    depthRange: [6, 24],
  });
  const fadeIn = new ColorByDepth({
    alpha: [0, 1],
    depthRange: [0, 1],
  });

  fadeOut.modify([particle], 0, context);
  fadeIn.modify([particle], 0, context);

  assert.equal(particle.alpha, 0.5);
}

context.system.destroy();
