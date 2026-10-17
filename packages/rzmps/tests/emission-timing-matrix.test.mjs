import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  Emitter,
  EmissionShape,
  ParticleSystem,
} from '../build/index.mjs';

function simulate(fps) {
  const emitter = new Emitter({
    rate: 17,
    bursts: [
      { time: 0.25, count: 3 },
      { time: 0.75, count: 2 },
    ],
    initialValues: { lifetime: 10 },
  });
  const system = new ParticleSystem({ renderers: [], duration: 2, looping: false });
  const particles = [];

  for (let frame = 0; frame <= fps * 2; frame += 1) {
    emitter.update(particles, {
      key: 'frame-rate-equivalence',
      elapsedTime: frame / fps,
      duration: 2,
    }, system);
  }

  return particles.length;
}

assert.deepEqual([30, 60, 120].map(simulate), [34, 34, 34]);

const burstEmitter = new Emitter({
  rate: 0,
  bursts: [
    { time: 0.1, count: 2 },
    { time: 0.4, count: 3 },
    { time: 0.8, count: 4 },
  ],
  initialValues: { lifetime: 10 },
});
const burstSystem = new ParticleSystem({ renderers: [], duration: 1 });
const burstParticles = [];
burstEmitter.update(burstParticles, { key: 'large-step', elapsedTime: 0, duration: 1 }, burstSystem);
burstEmitter.update(burstParticles, { key: 'large-step', elapsedTime: 0.9, duration: 1 }, burstSystem);
burstEmitter.update(burstParticles, { key: 'large-step', elapsedTime: 0.95, duration: 1 }, burstSystem);
assert.equal(burstParticles.length, 9);

const contextualEmitter = new Emitter({ rate: 4, initialValues: { lifetime: 10 } });
const contextParticles = [];
for (const elapsedTime of [0, 0.25, 0.5]) {
  contextualEmitter.update(contextParticles, { key: 'parent-a', elapsedTime, duration: 1 }, burstSystem);
}
for (const elapsedTime of [0, 0.25]) {
  contextualEmitter.update(contextParticles, { key: 'parent-b', elapsedTime, duration: 1 }, burstSystem);
}
assert.equal(contextParticles.length, 3);

const positionOffsetEmitter = new Emitter({
  source: EmissionShape.Sphere(1),
  rate: 0,
  bursts: { time: 0, count: 1 },
  initialValues: {
    lifetime: 1,
    position: new THREE.Vector3(1, 2, 3),
  },
});
positionOffsetEmitter.source.getPoint = () => ({
  position: new THREE.Vector3(),
  normal: new THREE.Vector3(0, 1, 0),
});
const offsetParticles = [];
positionOffsetEmitter.update(offsetParticles, {
  key: 'position-offset',
  elapsedTime: 0,
  duration: 1,
  transform: new THREE.Matrix4().makeTranslation(5, 0, 0),
}, burstSystem);
assert.equal(positionOffsetEmitter.supportsGPUEmission, true);
assert.deepEqual(offsetParticles[0].position.toArray(), [6, 2, 3]);
