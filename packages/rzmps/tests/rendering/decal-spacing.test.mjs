import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { DecalRenderer, Emitter, EmissionShape, ParticleSystem } from '../../build/index.mjs';

function fixture(options = {}) {
  const renderer = new DecalRenderer(new THREE.MeshStandardMaterial(), {
    onSpawn: false, onCollision: true, depth: 0.1, emissionTags: ['burn'], ...options,
  });
  const system = new ParticleSystem({ emitters: [], renderers: [renderer], simulationSpace: 'world' });
  const receiver = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshBasicMaterial());
  const scene = new THREE.Scene();
  scene.add(receiver, system); scene.updateMatrixWorld(true);
  const source = system.registerEmissionSource({ tags: ['contact'], transform: new THREE.Matrix4() });
  const hit = (x = 0, object = receiver, z = 0, normal = new THREE.Vector3(0, 0, 1)) => {
    source.emitEvent('collision', { object, point: new THREE.Vector3(x, 0, z), normal,
      impulse: normal.clone() });
  };
  return { system, receiver, renderer, source, hit };
}

test('decal minDistance defaults, strict boundary, no geometry/source allocation on rejection, independent cap', () => {
  for (const minDistance of [-1, 0]) {
    const f = fixture({ minDistance }); f.hit(); f.hit();
    assert.equal(f.renderer.count, 2); f.system.destroy();
  }
  assert.throws(() => fixture({ minDistance: -2 }), /minDistance/);
  assert.throws(() => fixture({ minDistance: NaN }), /minDistance/);
  const defaults = fixture();
  assert.equal(defaults.renderer.minDistance, -1);
  defaults.system.destroy();
  const f = fixture({ minDistance: 0.5, maxDecals: 2 });
  let geometryCalls = 0, sourceCalls = 0;
  const createGeometry = f.renderer.createGeometry.bind(f.renderer);
  const registerSource = f.system.registerEmissionSource.bind(f.system);
  f.renderer.createGeometry = (...args) => { geometryCalls++; return createGeometry(...args); };
  f.system.registerEmissionSource = (...args) => { sourceCalls++; return registerSource(...args); };
  f.hit(0);
  const first = f.renderer.decals[0], source = first.source, geometry = first.geometry;
  f.hit(0.49);
  assert.equal(geometryCalls, 1, 'rejection occurs before geometry construction');
  assert.equal(sourceCalls, 1, 'rejection never registers another source');
  assert.equal(f.renderer.count, 1);
  assert.equal(f.renderer.decals[0].source, source);
  assert.equal(f.renderer.decals[0].geometry, geometry);
  f.hit(0.5); assert.equal(f.renderer.count, 2, 'exactly the threshold is accepted');
  f.hit(1.01); assert.equal(f.renderer.count, 2, 'population cap is independent of spacing');
  assert.equal(source.alive, false, 'eviction releases the associated registered source');
  f.hit(0); assert.equal(f.renderer.decals[1].source.alive, true, 'eviction frees its spacing reservation');
  f.system.destroy();
});

test('spacing and public overlap queries respect receivers, opposite normals, separate sheets and rigid motion', () => {
  const f = fixture({ minDistance: 0.5 }); f.hit();
  const other = f.receiver.clone(); f.receiver.parent.add(other); other.updateMatrixWorld(true);
  f.hit(0, other); assert.equal(f.renderer.count, 2);
  assert.equal(f.renderer.queryDecals(f.receiver, new THREE.Vector3(), 0.1).length, 1);
  assert.equal(f.renderer.queryDecals(f.receiver, new THREE.Vector3(), 0.1, new THREE.Vector3(0, 0, -1)).length, 0);
  assert.equal(f.renderer.queryDecals(f.receiver, new THREE.Vector3(0, 0, 0.01), 0.1,
    new THREE.Vector3(0, 0, 1)).length, 0);
  const localSource = f.receiver.worldToLocal(f.renderer.decals[0].source.position.clone());
  f.receiver.position.x = 3; f.receiver.rotation.y = 0.4;
  f.receiver.updateMatrixWorld(true);
  f.renderer.update([], f.system, 0);
  assert(f.renderer.decals[0].source.position.distanceTo(f.receiver.localToWorld(localSource)) < 1e-6,
    'the registered source follows its receiver without replacing the decal');
  assert.equal(f.renderer.queryDecals(f.receiver, new THREE.Vector3(3, 0, 0), 0.1).length, 1);
  f.renderer.update([], f.system, 9);
  assert.equal(f.renderer.queryDecals(f.receiver, new THREE.Vector3(3, 0, 0), 0.1).length, 0);
  f.system.destroy();
});

test('accelerated decal queries agree with a brute-force receiver-local point reference after scale and rotation',
  () => {
  const f = fixture({ minDistance: -1, maxDecals: 200, size: 0.05 });
  const accepted = [];
  for (let i = 0; i < 80; i++) { const x = (i % 20) * 0.2 - 2; f.hit(x); accepted.push(x); }
  f.receiver.scale.set(1.7, 0.5, 1.2); f.receiver.rotation.z = 0.3; f.receiver.position.set(2, 1, -1);
  f.receiver.updateMatrixWorld(true);
  for (let i = 0; i < 30; i++) {
    const point = f.receiver.localToWorld(new THREE.Vector3(i * 0.13 - 2, 0, 0));
    const expected = accepted.filter(x => f.receiver.localToWorld(new THREE.Vector3(x, 0, 0))
      .distanceTo(point) <= 0.35).length;
    assert.equal(f.renderer.queryDecals(f.receiver, point, 0.35).length, expected);
  }
  f.system.destroy();
});

test('surface compatibility admits smooth curvature without admitting parallel disconnected sheets', () => {
  const f = fixture();
  f.hit();
  const x = 0.2, z = Math.sqrt(4 - x * x) - 2;
  const normal = new THREE.Vector3(x, 0, z + 2).normalize();
  assert.equal(f.renderer.queryDecals(f.receiver, new THREE.Vector3(x, 0, z), 0.5, normal).length, 1);
  f.system.destroy();
});


test('decal sources refresh moving receiver transforms before emission without a renderer update', () => {
  const f = fixture(); f.hit();
  const source = f.renderer.decals[0].source;
  const local = f.receiver.worldToLocal(source.position.clone());
  const shape = EmissionShape.Sphere(0.01);
  shape.getPoint = () => ({ position: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0) });
  const child = new ParticleSystem({ gravityModifier: 0, emitters: new Emitter({ source: shape,
    sourceTags: ['burn'], radialSpeed: 0, rate: 0, bursts: { time: 0, count: 1 },
    initialValues: { lifetime: 10 } }), renderers: [] });
  f.system.addSubSystem(child, { emitContinuous: true, inheritLifetime: 0, inheritScale: 0 });
  f.receiver.position.set(3, 2, 1); f.receiver.rotation.y = 0.6;
  child.deltaTime = 0.1;
  child.emissionRuntime._updateEmitterInstances([source]);
  const expected = f.receiver.localToWorld(local);
  assert.equal(child.particles.length, 1);
  assert(child.particles[0].position.distanceTo(expected) < 1e-6);
  assert(source.position.distanceTo(expected) < 1e-6);
  f.system.destroy();
  assert.equal(source.prepareEmission, undefined);
});

test('decal clocks advance through skipped renders without double-aging the rendered step', () => {
  const f = fixture({ lifetime: 8 }); f.hit();
  const decal = f.renderer.decals[0];
  f.system.deltaTime = 0.1;
  f.system._skipIntermediateRender = true;
  f.system._processParticles(); f.system._processParticles();
  assert(Math.abs(decal.age - 0.2) < 1e-9);
  assert(Math.abs(decal.source.age - 0.2) < 1e-9);
  f.system._skipIntermediateRender = false;
  f.system._processParticles();
  assert(Math.abs(decal.age - 0.3) < 1e-9);
  assert(Math.abs(decal.source.age - 0.3) < 1e-9);
  f.system.destroy();
});
