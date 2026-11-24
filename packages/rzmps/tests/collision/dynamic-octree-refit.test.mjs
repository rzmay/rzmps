import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { Particle, ThreeCollisionBackend } from '../../build/index.mjs';

function contact(backend, mesh) {
  mesh.updateWorldMatrix(true, false);
  const start = mesh.localToWorld(new THREE.Vector3(0.2, 0.45, 0.4));
  const end = mesh.localToWorld(new THREE.Vector3(0.2, 0.45, -0.03));
  return backend.collide({ start, end, radius: 0.08, velocity: end.clone().sub(start),
    particle: new Particle({ mass: 1 }) });
}

test('rigid/affine dynamic motion refits the existing octree and preserves contact provenance', () => {
  const geometry = new THREE.PlaneGeometry(4, 4, 4, 4);
  const original = geometry.attributes.position.array.slice();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  const backend = new ThreeCollisionBackend({ dynamicObjects: [mesh] });
  const tree = backend.dynamicOctree;
  for (let i = 0; i < 24; i++) {
    mesh.position.set(i * 0.12, Math.sin(i) * 0.2, -i * 0.03);
    mesh.rotation.set(i * 0.07, i * 0.09, i * 0.04);
    mesh.scale.set(1 + i * 0.01, 0.8 + i * 0.005, 1.2);
    mesh.updateMatrixWorld(true); backend.update(1 / 60);
    assert.equal(backend.dynamicOctree, tree, 'pose changes retain the acceleration topology');
    const expected = contact(new ThreeCollisionBackend({ dynamicObjects: [mesh] }), mesh);
    const actual = contact(backend, mesh);
    assert(expected && actual);
    assert(actual.point.distanceTo(expected.point) < 1e-5, JSON.stringify({ i, actual: actual.point,
      expected: expected.point, normal: actual.normal, expectedNormal: expected.normal }));
    assert(actual.normal.distanceTo(expected.normal) < 1e-5);
    assert.equal(actual.object, mesh); assert.equal(actual.material, mesh.material);
    assert(actual.surface, 'UV surface metadata remains available');
    const resolved = backend.dynamicOctree.bounds;
    assert(resolved.getSize(new THREE.Vector3()).length() < 10, 'rotations do not inflate old boxes indefinitely');
  }
  assert.deepEqual(geometry.attributes.position.array, original, 'refits do not mutate receiver geometry');
  geometry.dispose(); mesh.material.dispose();
});

test('unchanged poses/common group motion reuse trees; independent motion and geometry edits rebuild', () => {
  const root = new THREE.Group();
  const first = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  const second = new THREE.Mesh(new THREE.PlaneGeometry(2, 2)); second.position.x = 4;
  root.add(first, second); root.updateMatrixWorld(true);
  const backend = new ThreeCollisionBackend({ dynamicObjects: [first, second] });
  const initial = backend.dynamicOctree;
  backend.update(1 / 60); backend.update(1 / 60);
  assert.equal(backend.dynamicOctree, initial);
  root.position.x = 2; root.rotation.y = 0.4; root.updateMatrixWorld(true);
  backend.update(1 / 60); assert.equal(backend.dynamicOctree, initial);
  first.position.z = 1; root.updateMatrixWorld(true);
  backend.update(1 / 60); assert.notEqual(backend.dynamicOctree, initial);
  const moved = backend.dynamicOctree;
  first.geometry.translate(0.1, 0, 0); backend.update(1 / 60);
  assert.notEqual(backend.dynamicOctree, moved);
  const edited = backend.dynamicOctree;
  first.geometry.setAttribute('position', first.geometry.attributes.position.clone()); backend.update(1 / 60);
  assert.notEqual(backend.dynamicOctree, edited);
  const replaced = backend.dynamicOctree;
  first.geometry.attributes.uv.needsUpdate = true; backend.update(1 / 60);
  assert.notEqual(backend.dynamicOctree, replaced);
  const uvEdited = backend.dynamicOctree;
  backend.invalidateGeometry(first); backend.update(1 / 60);
  assert.notEqual(backend.dynamicOctree, uvEdited);
  first.geometry.dispose(); second.geometry.dispose();
});
