import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MeshRenderer, Particle, ParticleSystem } from '../build/index.mjs';

const material = new THREE.MeshStandardMaterial({ color: 'red', roughness: 0.25 });
const a = new THREE.Mesh(new THREE.BoxGeometry(), material);
const b = new THREE.Mesh(new THREE.TetrahedronGeometry(), new THREE.MeshStandardMaterial({ color: 'blue' }));
const one = new MeshRenderer({ mesh: [new THREE.Mesh(a.geometry, material.clone())], maxParticles: 1 });
assert.ok(one.instances.isInstancedMesh);
assert.equal(one.maxParticles, 1);
one.destroy();

assert.throws(() => new MeshRenderer({ mesh: [] }), /at least one/);
assert.throws(() => new MeshRenderer({ maxParticles: 0 }), /positive integer/);
const incompatible = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
assert.throws(() => new MeshRenderer({ mesh: [a, incompatible] }), /shader settings/);

const view = new MeshRenderer({ mesh: [a, b], maxParticles: 1, meshIndex: 1 });
assert.ok(view.instances.isBatchedMesh);
assert.equal(view.maxParticles, 1);
assert.equal(view.instances.geometry.hasAttribute('uv'), true);
assert.equal(view.instances.geometry.getAttribute('position').count,
  a.geometry.getAttribute('position').count + b.geometry.getAttribute('position').count);
assert.equal(a.geometry.hasAttribute('color'), false);
assert.equal(material.color.getHexString(), 'ff0000');
const system = new ParticleSystem({ emitters: [], renderers: view });
const particle = new Particle({ scale: new THREE.Vector3(2, 3, 4), alpha: 0.25 });
particle.position.set(4, 5, 6);
view.update([particle], system);
const batch = view.instances;
assert.equal(batch.getVisibleAt(0), false);
assert.equal(batch.getVisibleAt(1), true);
const matrix = new THREE.Matrix4();
batch.getMatrixAt(1, matrix);
assert.deepEqual(new THREE.Vector3().setFromMatrixPosition(matrix).toArray(), [4, 5, 6]);
const color = new THREE.Vector4();
batch.getColorAt(1, color);
assert.equal(color.w, 0.25);

// Growth, stable negative-index wrapping, then shrinking/clear must not leave old fragments visible.
view.meshIndex = -2;
view.update([particle, particle.clone()], system);
assert.ok(batch.maxInstanceCount >= 4);
assert.equal(view.maxParticles, Math.floor(batch.maxInstanceCount / 2));
assert.equal(batch.getVisibleAt(0), true);
assert.equal(batch.getVisibleAt(1), false);
view.update([particle], system);
assert.equal(batch.getVisibleAt(2), false);
assert.equal(batch.getVisibleAt(3), false);
view.clear();
assert.equal(batch.getVisibleAt(0), false);

// One conceptual mesh can contain multiple material groups; all its parts must render together.
const grouped = new THREE.Mesh(new THREE.BoxGeometry(), [material, b.material, material,
  b.material, material, b.material]);
const groups = new MeshRenderer({ mesh: [grouped, b], maxParticles: 1, meshIndex: 0 });
groups.update([particle], system);
for (let i = 0; i < 6; i++) assert.equal(groups.instances.getVisibleAt(i), true);
assert.equal(groups.instances.getVisibleAt(6), false);
groups.destroy();

let disposed = false;
a.geometry.addEventListener('dispose', () => { disposed = true; });
system.destroy();
assert.equal(disposed, false, 'source geometries remain caller-owned');
a.geometry.dispose();
b.geometry.dispose();
grouped.geometry.dispose();
incompatible.geometry.dispose();
incompatible.material.dispose();
material.dispose();
b.material.dispose();
console.log('Batched mesh selection, geometry normalization, alpha, growth, groups and ownership passed.');
