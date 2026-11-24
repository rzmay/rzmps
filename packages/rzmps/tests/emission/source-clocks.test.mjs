import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { Emitter, EmissionShape, Module, ParticleSystem } from '../../build/index.mjs';

const pointShape = () => {
  const shape = EmissionShape.Sphere(0.01);
  shape.getPoint = () => ({ position: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0) });
  return shape;
};

test('registered-source rate curves sample source lifetime independently of child duration', () => {
  const samples = [];
  const parent = new ParticleSystem({ emitters: [], renderers: [] });
  const child = new ParticleSystem({ duration: 60, emitters: new Emitter({ source: pointShape(),
    sourceTags: ['burn'], rate: time => { samples.push(time); return 0; } }), renderers: [] });
  parent.substep = child.substep = false;
  parent.addSubSystem(child, { emitContinuous: true, inheritLifetime: 0 });
  parent.registerEmissionSource({ tags: ['burn'], transform: new THREE.Matrix4(), age: 2, lifetime: 8 });
  parent.registerEmissionSource({ tags: ['burn'], transform: new THREE.Matrix4(), age: 3, lifetime: 6 });
  parent.advanceFrames(1, 0.1);
  assert.deepEqual(samples, [0.25, 0.5]);
  parent.destroy();
});

test('live-source emission continues evenly when an external clock pauses between owner updates', () => {
  const parent = new ParticleSystem({ emitters: [], renderers: [] });
  const births = [];
  const child = new ParticleSystem({ duration: 60, emitters: new Emitter({ source: pointShape(),
    sourceTags: ['burn'], rate: 10, initialValues: { lifetime: 10 } }), renderers: [],
    modules: new Module(() => {}, { initializeParticle(p) { births.push(p); } }) });
  parent.substep = child.substep = false;
  parent.addSubSystem(child, { emitContinuous: true, inheritLifetime: 0 });
  parent.registerEmissionSource({ tags: ['burn'], transform: new THREE.Matrix4(), age: 0, lifetime: 8 });
  const perStep = [];
  for (let step = 0; step < 5; step++) {
    const before = births.length; parent.advanceFrames(1, 0.1); perStep.push(births.length - before);
  }
  assert.deepEqual(perStep, [1, 1, 1, 1, 1]);
  parent.destroy();
});

test('finite sources use stable distinct birth phases and keep emission cadence after lifetime extension', () => {
  const parent = new ParticleSystem({ emitters: [], renderers: [] });
  const child = new ParticleSystem({ duration: 60, gravityModifier: 0, emitters: new Emitter({ source: pointShape(),
    sourceTags: ['burn'], rate: 10, radialSpeed: 0, initialValues: { lifetime: 10 } }), renderers: [] });
  parent.substep = child.substep = false;
  parent.addSubSystem(child, { emitContinuous: true, inheritLifetime: 0 });
  const sources = [0, 1].map(() => parent.registerEmissionSource({ tags: ['burn'],
    transform: new THREE.Matrix4(), age: 0, lifetime: 8 }));
  parent.advanceFrames(1, 0.1);
  assert.equal(child.particles.length, 2, 'new sources may emit during their first simulation interval');
  const firstAges = child.particles.map(particle => particle.realtime);
  assert(Math.abs(firstAges[0] - firstAges[1]) > 1e-6, 'sources must not share identical birth phases');
  sources[0].update({ age: 0.1, lifetime: 16 });
  parent.advanceFrames(1, 0.1);
  assert.equal(child.particles.length, 4);
  for (let i = 0; i < 2; i++) assert(Math.abs(child.particles[i + 2].realtime - firstAges[i]) < 1e-6);
  parent.destroy();
});

test('finite source sampling reflects lifetime changes before the next automatic source-clock tick', () => {
  const samples = [];
  const system = new ParticleSystem({ emitters: new Emitter({ source: pointShape(), sources: { tags: ['burn'] },
    rate: time => { samples.push(time); return 0; } }), renderers: [] });
  const source = system.registerEmissionSource({ tags: ['burn'], transform: new THREE.Matrix4(), lifetime: 8 });
  source.advanceClock(2, system.duration);
  source.update({ lifetime: 16 });
  system.deltaTime = 0.1;
  system.emissionRuntime._updateEmitterInstances();
  assert.deepEqual(samples, [0.125]);
  system.destroy();
});
