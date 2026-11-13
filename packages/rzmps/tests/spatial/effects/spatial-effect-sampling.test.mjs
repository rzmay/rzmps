import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Module, Particle, ParticleSystem, SpatialEffect, SpatialEffectCollection,
  BoidAffector, Boids, ParticleForceField, KillZone, GasAffector, GasSimulation } from '../../../build/index.mjs';

class Target extends SpatialEffect {}
class DerivedTarget extends Target {}
const a = new Target(null), b = new DerivedTarget(null), other = new SpatialEffect(null);
const collection = new SpatialEffectCollection();
collection.replace([a, b, a, other], [SpatialEffect, Target]);
assert(Array.isArray(collection));
assert.equal(collection.length, 3);
assert.deepEqual([...collection], [a, b, other]);
assert.deepEqual(collection.get(Target), [a, b]);
assert.deepEqual(collection.get(SpatialEffect), [a, b, other]);
assert.deepEqual(collection.filter(effect => effect instanceof Target), [a, b]);
collection.splice(0, 1);
assert.deepEqual(collection.get(Target), [b]);
const first = class Same extends SpatialEffect {}, second = class Same extends SpatialEffect {};
const x = new first(null), y = new second(null);
collection.replace([x, y]);
assert.deepEqual(collection.get(first), [x]);
assert.deepEqual(collection.get(second), [y]);

const system = new ParticleSystem({ emitters: [], renderers: [] });
const scene = new THREE.Scene();
scene.add(system, a, b, other);
const module = new Module(() => {}, { requireSpatialEffects: [SpatialEffect, Target],
  spatialEffectFilter: effect => effect !== other });
const context = module.beginExecution(system, 0.1);
module.prepare(context);
assert.equal(context.spatialEffects, module.spatialEffects);
assert.deepEqual([...context.spatialEffects], [a, b]);
assert.deepEqual(context.spatialEffects.get(Target), [a, b]);
const explicit = new Module(() => {}, { spatialEffects: [b, b, other], requireSpatialEffects: Target });
explicit.prepare(explicit.beginExecution(system, 0.1));
assert.deepEqual([...explicit.spatialEffects], [b]);
explicit.explicitSpatialEffects = [];
explicit.prepare(explicit.beginExecution(system, 0.1));
assert.equal(explicit.spatialEffects.length, 0);

// Exact requirements do not need scene membership and coexist with constructor/subclass discovery.
const detached = new Target(null);
const mixed = new Module(() => {}, { requireSpatialEffects: [Target, b, detached, detached] });
mixed.prepare(mixed.beginExecution(system, 0.1));
assert.deepEqual([...mixed.spatialEffects], [b, detached, a]);
assert.deepEqual(mixed.spatialEffects.get(Target), [b, detached, a]);
mixed.spatialEffectFilter = effect => effect !== detached;
mixed.prepare(mixed.beginExecution(system, 0.1));
assert.deepEqual([...mixed.spatialEffects], [b, a]);

const native = new GasAffector();
const wind = ParticleForceField.Box({ direction: new THREE.Vector3(2, 0, 0) });
scene.add(native, wind);
const gas = new GasSimulation();
gas.prepareSpatialEffects(system);
assert(gas.spatialEffects.includes(native));
assert(!gas.spatialEffects.includes(wind));
assert.equal(gas.supportForceFields, false);
gas.supportForceFields = true;
gas.supportForceFields = true;
assert.equal(gas.requireSpatialEffects.filter(entry => entry === ParticleForceField).length, 1);
gas.prepareSpatialEffects(system);
assert(gas.spatialEffects.includes(wind));
gas.supportForceFields = false;
gas.prepareSpatialEffects(system);
assert(!gas.spatialEffects.includes(wind));
gas.requireSpatialEffects = [Target, detached];
assert.equal(gas.supportForceFields, false);
gas.supportForceFields = true;
assert.deepEqual(gas.requireSpatialEffects, [Target, detached, ParticleForceField]);
gas.supportForceFields = false;
assert.deepEqual(gas.requireSpatialEffects, [Target, detached]);
gas.prepareSpatialEffects(system);
assert(!gas.spatialEffects.includes(native), 'direct replacement must not reinsert GasAffector');
const merged = new GasSimulation({ requireSpatialEffects: detached, supportForceFields: true });
assert(merged.requireSpatialEffects.includes(GasAffector));
assert(merged.requireSpatialEffects.includes(detached));
assert(merged.supportForceFields);
merged.cleanup();
gas.cleanup();

const effect = SpatialEffect.Sphere((particle, dt) => {
  particle.velocity.x += 2 * dt;
  particle.color.multiplyScalar(0.5);
  particle.alpha *= 0.5;
}, { feather: 1 }, 1, 12, 8);
const state = { velocity: new THREE.Vector3(1, 0, 0), color: new THREE.Color(0.4, 0.6, 0.8), alpha: 0.8 };
const close = (actual, expected) => assert(Math.abs(actual - expected) < 0.015, `${actual} != ${expected}`);
const delta = effect.sampleDeltas(new THREE.Vector3(1.5, 0, 0), state, 0.5, system);
close(delta.velocity.x, 0.5);
close(delta.color.r, -0.1);
close(delta.alpha, -0.2);
assert.equal(delta.killed, false);
assert.equal(state.velocity.x, 1);
assert.equal(state.alpha, 0.8);
assert.equal(effect.sampleDeltas(new THREE.Vector3(4, 0, 0), state, 0.5, system), delta);
assert.equal(delta.velocity.length(), 0);
assert.equal(delta.color.r, 0);
const filtered = SpatialEffect.Box(p => { p.alpha = 0; }, { tags: ['smoke'], condition: p => p.mass > 1 });
assert.equal(filtered.sampleDeltas(new THREE.Vector3(), { tags: ['water'], mass: 3 }, 1, system).alpha, 0);
assert.equal(filtered.sampleDeltas(new THREE.Vector3(), { tags: ['smoke'], mass: 3 }, 1, system).alpha, -1);
const killed = new KillZone({ geometry: new THREE.SphereGeometry(1) });
assert.equal(killed.sampleDeltas(new THREE.Vector3(), state, 1, system).killed, true);
assert.equal(killed.sampleDeltas(new THREE.Vector3(4, 0, 0), state, 1, system).killed, false);
const force = new ParticleForceField({ geometry: new THREE.SphereGeometry(1), direction: new THREE.Vector3(2, 0, 0) });
close(force.sampleDeltas(new THREE.Vector3(), { mass: 2 }, 0.5, system).velocity.x, 0.5);
force.position.set(3, 0, 0); force.scale.setScalar(2);
assert(force.sampleDeltas(new THREE.Vector3(3.5, 0, 0), { mass: 2 }, 0.5, system).velocity.x > 0);
assert.equal(force.sampleDeltas(new THREE.Vector3(), { mass: 2 }, 0.5, system).velocity.x, 0);
assert.equal(new BoidAffector().modifiesParticles, false);
assert.equal(new GasAffector().modifiesParticles, false);
assert.equal(new Boids().supportsGPU, true);
system.destroy();
console.log('Spatial collection, discovery, delta sampling, kill, tags, feathering and transforms passed.');
