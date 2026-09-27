import assert from 'node:assert/strict';
import {
  Emitter,
  Particle,
  ParticleSystem,
} from '../build/index.mjs';

/*
 * Checks:
 * - Event-triggered subsystem emission runs do not advance the subsystem's own looping clock.
 * - A looping subsystem used for emitOnSpawn does not repeatedly reset emitter burst state.
 * - The emission run itself still emits its burst once and then finishes.
 */

const parent = new ParticleSystem({
  renderers: [],
});
const child = new ParticleSystem({
  renderers: [],
  duration: 1,
  looping: true,
  emitters: new Emitter({
    rate: 0,
    bursts: [{ time: 0, count: 1 }],
    initialValues: {
      lifetime: 10,
    },
  }),
});

parent.addSubSystem(child, {
  emitOnSpawn: true,
});

const particle = new Particle({
  lifetime: 1,
});

parent._notifySpawn(particle);
parent.deltaTime = 0.5;
parent._updateSubSystems();

assert.equal(child.particles.length, 1);
assert.equal(child._elapsedTime, 0);

parent.deltaTime = 0.6;
parent._updateSubSystems();
parent.deltaTime = 0.6;
parent._updateSubSystems();

assert.equal(child.particles.length, 1);
assert.equal(child._emissionRuns.length, 0);
assert.equal(child._elapsedTime, 0);
