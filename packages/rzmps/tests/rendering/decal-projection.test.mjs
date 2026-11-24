import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';
import { DecalRenderer } from '../../build/index.mjs';

const renderer = new DecalRenderer(new THREE.MeshBasicMaterial());
const axis = new THREE.Vector3(0, 0, 1);

function compare(receiver, point = new THREE.Vector3(), warp = new THREE.Matrix3()) {
  receiver.updateWorldMatrix(true, false);
  const normal = axis.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(receiver.matrixWorld)).normalize();
  const parameters = { position: point.clone().applyMatrix4(receiver.matrixWorld), normal,
    size: new THREE.Vector3(0.9, 0.7, 1), rotation: 0.23, depth: 0.4, offset: 0.001 };
  const bounds = new THREE.Box2();
  for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) {
    const p = new THREE.Vector3(x, y, 1).applyMatrix3(warp);
    bounds.expandByPoint(new THREE.Vector2(p.x / p.z, p.y / p.z));
  }
  const center = bounds.getCenter(new THREE.Vector2()), extents = bounds.getSize(new THREE.Vector2());
  const orientation = new THREE.Quaternion().setFromUnitVectors(axis, normal)
    .multiply(new THREE.Quaternion().setFromAxisAngle(axis, parameters.rotation));
  const position = parameters.position.clone().add(new THREE.Vector3(
    center.x * parameters.size.x, center.y * parameters.size.y, 0).applyQuaternion(orientation));
  const reference = new DecalGeometry(receiver, position, new THREE.Euler().setFromQuaternion(orientation),
    new THREE.Vector3(parameters.size.x * extents.x, parameters.size.y * extents.y, parameters.depth));
  const uv = reference.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) + center.x / extents.x,
    uv.getY(i) + center.y / extents.y);
  reference.translate(normal.x * parameters.offset, normal.y * parameters.offset, normal.z * parameters.offset);
  reference.applyMatrix4(receiver.matrixWorld.clone().invert());
  const actual = renderer.createGeometry({ object: receiver }, parameters, warp);
  if (reference.attributes.position.count === 0) {
    assert.equal(actual, undefined);
  } else {
    assert(actual, 'selected projection must preserve nonempty coverage');
    for (const name of ['position', 'normal', 'uv']) {
      const expected = reference.attributes[name], selected = actual.attributes[name];
      assert.equal(selected?.count, expected?.count, `${name}: identical clipped triangle count`);
      for (let i = 0; i < (expected?.array.length ?? 0); i++) {
        assert(Math.abs(expected.array[i] - selected.array[i]) < 2e-5, `${name}[${i}]`);
      }
    }
    actual.dispose();
  }
  reference.dispose();
}

test('selected projection matches Three.js on indexed/nonindexed receivers, transforms and asymmetric warps', () => {
  for (const indexed of [true, false]) {
    const plane = new THREE.PlaneGeometry(12, 12, 48, 48);
    const geometry = indexed ? plane : plane.toNonIndexed();
    const receiver = new THREE.Mesh(geometry);
    const originalIndex = geometry.index?.array.slice();
    const parent = new THREE.Group();
    parent.rotation.set(0.2, -0.4, 0.1); parent.scale.set(1.1, 0.8, 1.3);
    parent.add(receiver);
    receiver.position.set(2, 1, -0.5); receiver.rotation.set(-0.3, 0.2, 0.5);
    receiver.scale.set(-1.2, 0.6, 1.5);
    compare(receiver);
    compare(receiver, new THREE.Vector3(1, 1, 0), new THREE.Matrix3().set(1, 0.2, 0, 0, 1, 0, -0.7, 0, 1));
    receiver.position.x += 2; receiver.rotation.y += 0.6;
    compare(receiver);
    compare(receiver, new THREE.Vector3(40, 0, 0));
    assert.deepEqual(geometry.index?.array, originalIndex, 'BVH must not add or reorder receiver indices');
    assert.equal(geometry.boundsTree, undefined, 'private acceleration must not modify a caller-owned BVH');
    geometry.dispose(); plane.dispose();
  }
});

test('projection preserves full-geometry semantics, curved normals and missing/interleaved attributes', () => {
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(2, 48, 32));
  sphere.geometry.clearGroups(); sphere.geometry.addGroup(0, 3, 0); sphere.geometry.setDrawRange(0, 3);
  compare(sphere, new THREE.Vector3(0, 0, 2));
  const plane = new THREE.PlaneGeometry(12, 12, 32, 32);
  plane.deleteAttribute('normal');
  const position = plane.attributes.position;
  const buffer = new THREE.InterleavedBuffer(new Float32Array(position.array), 3);
  plane.setAttribute('position', new THREE.InterleavedBufferAttribute(buffer, 3, 0));
  compare(new THREE.Mesh(plane));
  plane.dispose(); sphere.geometry.dispose();
});

test('cached selection refits positions and rebuilds for index/attribute edits and disposal', () => {
  const geometry = new THREE.PlaneGeometry(12, 12, 32, 32), receiver = new THREE.Mesh(geometry);
  compare(receiver);
  geometry.translate(0, 0, 2);
  compare(receiver, new THREE.Vector3(0, 0, 2));
  const index = geometry.index;
  const values = Array.from(index.array).reverse();
  index.array.set(values); index.needsUpdate = true;
  compare(receiver, new THREE.Vector3(0, 0, 2));
  geometry.setAttribute('position', geometry.attributes.position.clone());
  compare(receiver, new THREE.Vector3(0, 0, 2));
  geometry.dispose();
  compare(receiver, new THREE.Vector3(0, 0, 2));
  geometry.dispose();
});

test('warmed projection fetches only local receiver vertices instead of scanning the entire mesh', () => {
  const geometry = new THREE.PlaneGeometry(20, 20, 128, 128), receiver = new THREE.Mesh(geometry);
  compare(receiver);
  const position = geometry.attributes.position, getX = position.getX;
  let reads = 0;
  position.getX = function (index) { reads++; return getX.call(this, index); };
  const parameters = { position: new THREE.Vector3(), normal: axis, size: new THREE.Vector3(0.5, 0.5, 1),
    rotation: 0, depth: 0.2, offset: 0 };
  const selected = renderer.createGeometry({ object: receiver }, parameters, new THREE.Matrix3());
  const selectedReads = reads;
  reads = 0;
  const reference = new DecalGeometry(receiver, new THREE.Vector3(), new THREE.Euler(),
    new THREE.Vector3(0.5, 0.5, 0.2));
  assert(selectedReads < reads / 10, `${selectedReads} local reads versus ${reads} full-mesh reads`);
  assert.equal(selected.attributes.position.count, reference.attributes.position.count);
  selected.dispose(); reference.dispose(); geometry.dispose();
});
