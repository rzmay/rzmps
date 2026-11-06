import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Emitter, Module, ParticleSystem, MaterialCopy, MaterialCopySource, MaterialCopySampleMode }
  from '../build/index.mjs';

const order = [];
const system = new ParticleSystem({ emitters: new Emitter({ rate: 0, bursts: [{ time: 0, count: 1 }],
  initialValues: { lifetime: 10, mass: 3 } }), renderers: [], gravityModifier: 0,
  modules: [new Module(p => { assert.equal(p.mass, 10); }, { initializeParticle: p => {
    p.mass += 2; order.push('first');
  } }), new Module(() => {}, { initializeParticle: p => { p.mass *= 2; order.push('second'); } })] });
system.onSpawn(p => { assert.equal(p.mass, 10); order.push('observer'); });
system.advanceFrames(3, 0.01);
assert.deepEqual(order, ['first', 'second', 'observer']);
assert.equal(system.particles[0].mass, 10);
system.destroy();

const material = new THREE.MeshStandardMaterial({ color: 'red' });
const parent = new ParticleSystem({ emitters: [], renderers: [] });
const source = parent.registerEmissionSource({ transform: new THREE.Matrix4(), metadata: { material } });
const seen = [];
const child = new ParticleSystem({ renderers: [], looping: false, duration: 1, gravityModifier: 0,
  emitters: new Emitter({ rate: 0, bursts: [{ time: 0, count: 1 }], initialValues: { lifetime: 10 } }),
  modules: [new MaterialCopy({ source: MaterialCopySource.Event, sampleMode: MaterialCopySampleMode.Color }),
    new Module(() => {}, { initializeParticle: (p, context) => {
      assert.equal(context.event.name, 'paint');
      assert.equal(context.source.id, source.id);
      assert.ok(p.materialCopy.x > 0);
      seen.push('initialize');
    } })] });
parent.addSubSystem(child, { onEvent: ['paint'] });
child.onSpawn(p => { assert.ok(p.materialCopy.x > 0); seen.push('observe'); });
source.emitEvent('paint', { material });
parent.advanceFrames(1, 0.01);
assert.deepEqual(seen, ['initialize', 'observe']);
assert.equal(child.particles[0].materialCopy.w, MaterialCopySampleMode.Color);
parent.destroy();

const registered = new ParticleSystem({ emitters: [], renderers: [] });
registered.registerEmissionSource({ transform: new THREE.Matrix4(), metadata: { material } });
const follow = new ParticleSystem({ renderers: [], modules: new MaterialCopy({ source: MaterialCopySource.Source }),
  emitters: new Emitter({ rate: 0, bursts: [{ time: 0, count: 1 }], initialValues: { lifetime: 10 } }) });
registered.addSubSystem(follow, { emitContinuous: true, inheritLifetime: 0 });
registered.advanceFrames(1, 0.01);
assert.equal(follow.particles.length, 1);
assert.ok(follow.particles[0].materialCopy.x > 0);
registered.destroy();
material.dispose();
console.log('Synchronous initialization order, observer ordering, custom events and registered sources passed.');

// A registered decal source supplies the surface contact, not the damage material's albedo.
{
  const { DecalRenderer, EmissionShape, Particle } = await import('../build/index.mjs');
  const surface = new THREE.MeshStandardMaterial({ color: 'red' });
  const damage = new THREE.MeshStandardMaterial({ color: 'black' });
  const decals = new DecalRenderer(damage, { emissionTags: ['bullet-hole'], tags: ['projectile'], inheritColor: 0 });
  const root = new ParticleSystem({ emitters: [], renderers: decals });
  const scene = new THREE.Scene();
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), surface);
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor, root);
  const dust = new ParticleSystem({ duration: 0.12, looping: false, gravityModifier: 0,
    renderers: [], modules: new MaterialCopy({ source: MaterialCopySource.Source,
      sampleMode: MaterialCopySampleMode.Color }),
    emitters: new Emitter({ source: EmissionShape.Sphere(0.5), rate: 0,
      bursts: [{ time: 0, count: 4 }], initialValues: { lifetime: 1 } }),
  });
  root.addSubSystem(dust, { tags: ['bullet-hole'], emitOnSpawn: true, inheritLifetime: 0,
    inheritScale: 0, inheritColor: 0, inheritAlpha: 0 });
  scene.updateMatrixWorld(true);
  root._notifySpawn(new Particle({ position: new THREE.Vector3(2, 1, 0), tags: ['projectile'] }));
  const handle = decals.decals[0].source;
  assert.equal(handle.metadata.material, surface);
  const contactUV = handle.metadata.surface.uv;
  root.advanceFrames(30, 0.01);
  assert.equal(dust.particles.length, 4, 'a persistent decal must emit just one small burst');
  for (const particle of dust.particles) {
    assert.equal(particle.materialCopy.w, MaterialCopySampleMode.Color);
    assert.ok(Math.abs(particle.materialCopy.y - contactUV.x) < 1e-6);
    assert.ok(Math.abs(particle.materialCopy.z - contactUV.y) < 1e-6);
    assert.ok(root.materialCopyRegistry.sources[particle.materialCopy.x].color.equals(surface.color));
  }
  root.destroy(); floor.geometry.dispose(); surface.dispose(); damage.dispose();
}
