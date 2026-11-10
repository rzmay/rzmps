import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  AudioRenderer,
  Particle,
  ParticleSystem,
} from '../../build/index.mjs';

/*
 * Checks:
 * - Pitch multiplies base pitch by size, alpha, and speed effects.
 * - Volume can be attenuated by camera-depth normalization.
 * - High-pass cutoff can be computed from its base value plus alpha effects.
 * - Low-pass cutoff can be computed from its base value plus speed effects.
 * - Filter cutoff calculations do not require collision impulse modifiers.
 * - Doppler pitch is off by default and increases pitch for particles approaching the listener.
 * - Renderer event callbacks are removed on destroy.
 */

const particle = new Particle({
  alpha: 0.5,
  scale: new THREE.Vector3(2, 0, 0),
  velocity: new THREE.Vector3(4, 0, 0),
});

{
  const audio = new AudioRenderer({
    pitch: 2,
    sizeAffectsPitch: 1,
    alphaAffectsPitch: 1,
    speedAffectsPitch: 1,
  });

  assert.equal(audio._getPitch(particle), 8);
}

{
  const audio = new AudioRenderer({
    volume: 2,
    depthAffectsVolume: 1,
  });

  particle.position.z = 50;

  assert.equal(audio._getVolume(particle), 1);
}

{
  const audio = new AudioRenderer({
    highPass: 1000,
    alphaAffectsHighPass: 1,
  });

  assert.equal(audio._getHighPassFrequency(particle), 500);
}

{
  const audio = new AudioRenderer({
    lowPass: 1000,
    speedAffectsLowPass: 1,
  });

  assert.equal(audio._getLowPassFrequency(particle), 4000);
}

{
  const audio = new AudioRenderer({
    pitch: 1,
    dopplerEffect: 0,
  });

  assert.equal(audio._getPitch(particle), 1);
}

{
  const audio = new AudioRenderer({
    pitch: 1,
    dopplerEffect: 1,
  });

  audio._deltaTime = 1;
  audio._relativePositions.set(particle.id, new THREE.Vector3(0, 0, 10));
  particle.position.set(0, 0, 9);

  assert.ok(audio._getPitch(particle) > 1);
}

{
  const audio = new AudioRenderer({ gpuInterpolationRate: 10 });
  const position = new THREE.Vector3();
  const targetPosition = new THREE.Vector3(10, 0, 0);
  audio._particleAudio.set('gpu-particle', {
    audio: { position },
    targetPosition,
    velocity: new THREE.Vector3(2, 0, 0),
    speed: 3,
    filters: {},
  });

  audio._advanceGPUAudio(0.1);

  assert.equal(Number(targetPosition.x.toFixed(4)), 10.6);
  assert.ok(position.x > 0 && position.x < targetPosition.x);
}

{
  const audio = new AudioRenderer({ onSpawnSound: {} });
  const system = new ParticleSystem({ emitters: [], renderers: audio });
  let cues = 0;
  audio._playOneShot = () => { cues++; };
  system.registerEmissionSource({ transform: new THREE.Matrix4() });
  assert.equal(cues, 1);

  audio.clear();
  system.registerEmissionSource({ transform: new THREE.Matrix4() });
  assert.equal(cues, 2, 'clear keeps the named event subscription');

  audio.destroy();
  system.registerEmissionSource({ transform: new THREE.Matrix4() });
  assert.equal(cues, 2, 'destroy releases the named event subscription');
  system.destroy();
}
