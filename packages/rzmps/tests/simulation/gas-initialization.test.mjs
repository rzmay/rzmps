import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { GasModule, Particle, ParticleSystem } from '../../build/index.mjs';

const owner = () => new ParticleSystem({ emitters: [], renderers: [] });
const context = () => ({ index: new THREE.Vector3(), position: new THREE.Vector3(), deltaTime: 0.1, elapsedTime: 1 });
const emission = () => ({ density: 2, temperature: 4, color: new THREE.Color(1, 0.5, 0),
  velocity: new THREE.Vector3(1, 2, 3) });

test('registered source clocks retain external age and respond to lifetime extension', () => {
  const system = owner();
  const source = system.registerEmissionSource({ transform: new THREE.Matrix4(), age: 3, lifetime: 4 });
  source.advanceClock(1, 10);
  assert.equal(source.age, 3);
  assert.equal(source.time, 0.75);
  source.update({ lifetime: 8 });
  assert.equal(source.age, 3);
  assert.equal(source.time, 0.375);
  source.update({ age: undefined });
  source.advanceClock(1, 10);
  assert.equal(source.age, 4);
  assert.equal(source.time, 0.5);
  assert.throws(() => source.update({ lifetime: 0 }), /lifetime/);
  assert.throws(() => source.update({ age: NaN }), /age/);
  system.destroy();
});

test('world-space particles and clones retain live registered-source provenance', () => {
  const system = owner();
  const source = system.registerEmissionSource({ transform: new THREE.Matrix4(), metadata: { heat: 2 } });
  const particle = new Particle({ lifetime: 10 });
  system.bindParticleSource(particle, source);
  assert.equal(particle.source, source);
  assert.equal(particle.source.metadata.heat, 2);
  assert.equal(particle.clone().source, source);
  source.dispose();
  assert.equal(particle.source, undefined);
  system.destroy();
});

test('CPU initialization composes in priority order with live source cooling and metadata', () => {
  const system = owner();
  const sources = [1, 3].map(age => system.registerEmissionSource({ transform: new THREE.Matrix4(),
    age, lifetime: 4, metadata: { factor: 2 } }));
  const particles = sources.map(source => {
    const particle = new Particle({ lifetime: 10 }); system.bindParticleSource(particle, source); return particle;
  });
  const cooling = new GasModule({ priority: -1, initialize(particles, value) {
    if (!particles.length) return;
    let heat = 0, count = 0;
    for (const particle of particles) {
      if (!particle.source) continue;
      heat += 1 - particle.source.age / particle.source.lifetime; count++;
    }
    if (count) value.temperature *= heat / count;
  } });
  const modifier = new GasModule({ initialize(particles, value) {
    value.density *= particles[0].source.metadata.factor;
    value.color.multiplyScalar(0.5); value.velocity.multiplyScalar(2);
  } });
  const disabled = new GasModule({ enabled: false, initialize() { throw Error('disabled'); } });
  const value = emission();
  GasModule.initializeEmission([modifier, disabled, cooling], particles, value, context());
  assert.equal(value.temperature, 2);
  assert.equal(value.density, 4);
  assert.deepEqual(value.velocity.toArray(), [2, 4, 6]);
  sources[1].update({ lifetime: 8 });
  const reheated = emission();
  GasModule.initializeEmission([cooling], particles, reheated, context());
  assert.equal(reheated.temperature, 2.75);
  const empty = emission();
  GasModule.initializeEmission([cooling], [], empty, context());
  assert.equal(empty.temperature, 4);
  system.destroy();
});

test('initialization discovery and callback invalidation remain stage-local', () => {
  const module = new GasModule({ initialize() {}, initializeGPU() {}, modifyGPU() {} });
  const system = owner(); system.addModule(module);
  assert.deepEqual(GasModule.collect(system, undefined, 'Initialization'), [module]);
  const init = module.graphKey('Initialization'), sim = module.graphKey('Simulation');
  module.initializeGPU = () => {};
  assert.notEqual(module.graphKey('Initialization'), init);
  assert.equal(module.graphKey('Simulation'), sim);
  system.destroy();
});
