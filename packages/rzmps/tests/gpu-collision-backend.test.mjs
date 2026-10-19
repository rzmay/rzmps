import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  Collision,
  CollisionGeometryUpdatePolicy,
  ThreeCollisionBackend,
  ThreeGPUCollisionBackend,
} from '../build/index.mjs';

const scene = new THREE.Scene();
const sharedGeometry = new THREE.BoxGeometry(1, 1, 1);
const first = new THREE.Mesh(sharedGeometry);
const second = new THREE.Mesh(sharedGeometry);
second.position.x = 2;
scene.add(first, second);

const backend = new ThreeGPUCollisionBackend({
  world: scene,
  updatePolicy: CollisionGeometryUpdatePolicy.Auto,
});
backend.update();
assert.equal(backend.supportsGPU, true);
assert.equal(backend.supportsCPU, false);
assert.equal(backend.stats.objects, 2);
assert.equal(backend.stats.uniqueGeometries, 1);
assert.equal(backend.stats.fullBuilds, 1);
assert.ok(backend.stats.uploadBytes > 0);
const stableCollisionQuery = backend.capsuleQuery;

const unchangedStats = { ...backend.stats };
backend.update();
assert.deepEqual(backend.stats, unchangedStats, 'unchanged scenes must not schedule uploads');

first.position.y = 1;
first.scale.set(2, 0.5, 1.5);
first.updateMatrixWorld();
backend.update();
assert.equal(backend.stats.transformUpdates, 1);
assert.equal(backend.stats.fullBuilds, 1, 'transform-only updates must not repack BLAS data');
assert.ok(backend.stats.uploadBytes > unchangedStats.uploadBytes);

sharedGeometry.attributes.position.setX(0, -0.75);
sharedGeometry.attributes.position.needsUpdate = true;
backend.update();
assert.equal(backend.stats.geometryRefits, 1);
assert.equal(backend.stats.fullBuilds, 2);
assert.equal(backend.capsuleQuery, stableCollisionQuery);

backend.invalidateGeometry(first);
backend.update();
assert.equal(backend.stats.geometryRefits, 2);

const replacementPositions = sharedGeometry.attributes.position.clone();
replacementPositions.setX(1, replacementPositions.getX(1) + 0.1);
sharedGeometry.setAttribute('position', replacementPositions);
backend.update();
assert.equal(
  backend.stats.geometryRefits,
  3,
  'same-sized position attribute replacement must be detected as deformation',
);

sharedGeometry.setDrawRange(0, Math.max(3, sharedGeometry.index.count - 3));
backend.update();
assert.ok(backend.stats.topologyRebuilds >= 1, 'draw-range changes must rebuild topology');
assert.equal(
  backend.capsuleQuery,
  stableCollisionQuery,
  'geometry repacks must preserve the shader query graph and proxy bindings',
);

const replacement = new THREE.SphereGeometry(1, 8, 6);
backend.setEvaluatedGeometry(first, replacement);
backend.update();
assert.ok(backend.stats.topologyRebuilds >= 1);

scene.remove(second);
backend.update();
assert.equal(backend.stats.objects, 1);

{
  const manyScene = new THREE.Scene();
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const meshes = Array.from({ length: 256 }, (_unused, index) => {
    const mesh = new THREE.Mesh(geometry);
    mesh.position.set(index % 16, Math.floor(index / 16), 0);
    manyScene.add(mesh);
    return mesh;
  });
  const manyBackend = new ThreeGPUCollisionBackend({ world: manyScene });
  manyBackend.update();
  const initialBuilds = manyBackend.stats.fullBuilds;
  meshes.forEach((mesh, index) => {
    mesh.position.z = index * 0.01;
    mesh.updateMatrixWorld();
  });
  manyBackend.update();
  assert.equal(manyBackend.stats.objects, 256);
  assert.equal(manyBackend.stats.uniqueGeometries, 1);
  assert.equal(manyBackend.stats.transformUpdates, 1);
  assert.equal(manyBackend.stats.fullBuilds, initialBuilds);
  manyBackend.destroy();
  assert.equal(geometry.boundsTree, undefined);
  geometry.dispose();
}

const explicitCPU = new ThreeCollisionBackend({ world: scene });
const module = new Collision({ backend: explicitCPU });
assert.equal(module.backend, explicitCPU);
assert.equal(module.supportsGPU, false);

backend.destroy();
assert.equal(backend.hasGeometry, false);
explicitCPU.destroy?.();
sharedGeometry.dispose();
replacement.dispose();
console.log('gpu-collision-backend tests passed');
