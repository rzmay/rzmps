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

first.position.y = 1;
first.updateMatrixWorld();
backend.update();
assert.equal(backend.stats.transformUpdates, 1);
assert.equal(backend.stats.fullBuilds, 1, 'transform-only updates must not repack BLAS data');

sharedGeometry.attributes.position.setX(0, -0.75);
sharedGeometry.attributes.position.needsUpdate = true;
backend.update();
assert.equal(backend.stats.geometryRefits, 1);
assert.equal(backend.stats.fullBuilds, 2);

backend.invalidateGeometry(first);
backend.update();
assert.equal(backend.stats.geometryRefits, 2);

const replacement = new THREE.SphereGeometry(1, 8, 6);
backend.setEvaluatedGeometry(first, replacement);
backend.update();
assert.ok(backend.stats.topologyRebuilds >= 1);

const explicitCPU = new ThreeCollisionBackend({ world: scene });
const module = new Collision({ backend: explicitCPU });
assert.equal(module.backend, explicitCPU);
assert.equal(module.supportsGPU, false);

backend.destroy();
explicitCPU.destroy?.();
sharedGeometry.dispose();
replacement.dispose();
console.log('gpu-collision-backend tests passed');
