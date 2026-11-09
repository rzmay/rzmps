import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Emitter, Particle, ParticleSystem } from '../build/index.mjs';

function emit({ impulse = 1, effect = 0.5, rate = 16, bursts = [{ time: 0, count: 8 }], spawn = false } = {}) {
  const parent = new ParticleSystem({ renderers: [], emitters: [], gravityModifier: 0 });
  const child = new ParticleSystem({ renderers: [], duration: 1, looping: false, gravityModifier: 0,
    emitters: new Emitter({ rate, bursts, radialSpeed: 0, initialValues: { lifetime: 10 } }) });
  parent.addSubSystem(child, {
    emitOnCollision: !spawn, emitOnSpawn: spawn, inheritLifetime: 0, impulseThreshold: -1,
    ...(effect === null ? {} : { impulseAffectsCount: effect }),
  });
  const particle = new Particle({ lifetime: 10 });
  if (spawn) parent._notifySpawn(particle);
  else parent.notifyCollision(particle, { point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0),
    impulse: new THREE.Vector3(0, impulse, 0) });

  for (let step = 0; step < 8; step++) {
    parent.deltaTime = 0.125;
    parent._updateSubSystems();
  }
  const count = child.particles.length;
  parent.destroy();
  return count;
}

// The run emits one burst plus 0.75 seconds of rate after initializing its emission context.
for (const [impulse, factor] of [[0.25, 0.5], [1, 1], [4, 2]]) {
  assert.equal(emit({ impulse }), 20 * factor);
  assert.equal(emit({ impulse, rate: 0 }), 8 * factor);
  assert.equal(emit({ impulse, bursts: [] }), 12 * factor);
}
assert.equal(emit({ impulse: 0 }), 0);
assert.equal(emit({ impulse: 4, effect: null }), 20, 'Omitting the option preserves existing emission');
assert.equal(emit({ impulse: 4, effect: 0 }), 20, 'Disabled scaling preserves existing emission');
assert.equal(emit({ impulse: 4, effect: 1 }), 80, 'Exponent one is linear');
assert.equal(emit({ impulse: 4, spawn: true }), 20, 'Noncollision events retain configured counts');
assert.equal(emit({ impulse: 0.25, rate: 0, bursts: [0, 0.25, 0.5, 0.75]
  .map(time => ({ time, count: 1 })) }), 2, 'Fractional burst credits carry between bursts in a run');

// Count scaling also composes with LOD and distance emission, without discarding fractional credit.
const emitter = new Emitter({ rate: 0, rateOverDistance: 3, radialSpeed: 0,
  bursts: [{ time: 0, count: 8 }], initialValues: { lifetime: 10 } });
const system = new ParticleSystem({ emitters: [], renderers: [] });
system.quality = 0.5;
for (let step = 0; step <= 4; step++) {
  emitter.update(system.particles, { key: 'distance', elapsedTime: step * 0.1, duration: 1,
    position: new THREE.Vector3(step, 0, 0), countScale: 0.5 }, system);
}
assert.equal(system.particles.length, 5, '8*0.25 burst + 4*3*0.25 distance');
system.destroy();
console.log('Impulse-scaled bursts, rates, distance, fractional credits and unchanged noncollision emission passed.');
