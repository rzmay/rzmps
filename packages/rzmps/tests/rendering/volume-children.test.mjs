import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { ParticleSystem, VolumeRenderer, CompensationMode } from '../../build/index.mjs';

function fixture(children, quality = 1, compensation = CompensationMode.None) {
  const field = { data: new Float32Array(64).fill(1), resolution: new THREE.Vector3(4, 4, 4),
    bounds: new THREE.Box3(new THREE.Vector3(-2, -0.5, -0.25), new THREE.Vector3(2, 0.5, 0.25)), version: 0 };
  const volume = new VolumeRenderer({ field, children, compensation });
  const owner = new ParticleSystem({ emitters: [], renderers: [volume] });
  new THREE.Scene().add(owner);
  owner.quality = quality;
  volume.update([], owner);
  return { owner, volume };
}

test('volume child rotation expands rectangular bounds and runtime rotations reuse child uniforms', () => {
  const { owner, volume } = fixture({ count: 1, rotation: new THREE.Vector3(0, 0, Math.PI / 2) });
  try {
    assert(volume.bounds.min.distanceTo(new THREE.Vector3(-2, -2, -0.25)) < 1e-8);
    assert(volume.bounds.max.distanceTo(new THREE.Vector3(2, 2, 0.25)) < 1e-8);
    const child = volume.layers[0].children[1], matrix = child.rotation.value, material = volume.webgpuMaterial;
    assert(child.rotated); assert(!volume.layers[0].children[0].rotated);
    assert(new THREE.Vector3(1, 0, 0).applyMatrix3(matrix).distanceTo(new THREE.Vector3(0, 1, 0)) < 1e-8);
    volume.children.rotation.z = -Math.PI / 2;
    volume.update([], owner);
    assert.equal(volume.layers[0].children[1].rotation.value, matrix);
    assert.equal(volume.webgpuMaterial, material, 'changing nonzero rotation only updates uniforms');
    assert(new THREE.Vector3(1, 0, 0).applyMatrix3(matrix).distanceTo(new THREE.Vector3(0, -1, 0)) < 1e-8);
    assert.match(volume.webglMaterial.fragmentShader, /layerInverseRotation1 \* \(point/);
  } finally { owner.destroy(); }
});

test('volume rotation follows radial falloff with independent deterministic random variation', () => {
  const { owner, volume } = fixture({ count: 12, radius: 1, rotation: t => new THREE.Vector3(0, 0, t),
    scale: [0.3, 1], alpha: [0.3, 1], randomizeScale: 0.4, randomizeAlpha: 0.6,
    radialFalloff: t => t * t });
  const copies = () => volume.layers[0].children.slice(1);
  const values = () => copies().map(child => ({ rotation: child.rotation.value.toArray(),
    offset: child.offset.value.toArray(), scale: child.scale.value, alpha: child.alpha.value }));
  try {
    for (const child of copies()) {
      const angle = child.offset.value.length() ** 2;
      const expected = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationZ(angle));
      assert(child.rotation.value.elements.every((value, index) => Math.abs(value - expected.elements[index]) < 1e-10));
    }
    const before = values();
    volume.children.randomizeRotation = 0.8;
    volume.update([], owner);
    const after = values(), unrotated = rows => rows.map(({ offset, scale, alpha }) => ({ offset, scale, alpha }));
    assert.notDeepEqual(after.map(row => row.rotation), before.map(row => row.rotation));
    assert.deepEqual(unrotated(after), unrotated(before));
    volume.update([], owner);
    assert.deepEqual(values(), after);
  } finally { owner.destroy(); }
});

test('LOD copies inherit their artistic volume parent rotation exactly once', () => {
  const { owner, volume } = fixture({ count: 1, rotation: 0.3 }, 0.5, CompensationMode.Children);
  try {
    const children = volume.layers[0].children;
    assert.equal(children.length, 4);
    assert(children[2].rotation.value.equals(children[0].rotation.value));
    assert(children[3].rotation.value.equals(children[1].rotation.value));
  } finally { owner.destroy(); }
});

test('allocation-bound changes do not move a rotated copy of a fixed world point', () => {
  const { owner, volume } = fixture({ count: 1, rotation: new THREE.Vector3(0, 0, Math.PI / 2) });
  try {
    const layer = volume.layers[0], child = layer.children[1], point = new THREE.Vector3(0.4, 0.1, 0);
    const transform = () => point.clone().sub(child.pivot.value).applyMatrix3(child.rotation.value)
      .add(child.pivot.value).add(child.offset.value);
    const expected = transform(), pivot = child.pivot.value.clone(), material = volume.webgpuMaterial;
    layer.density.field.bounds.min.y -= 4;
    layer.density.field.bounds.max.x += 2;
    volume.update([], owner);
    assert(child.pivot.value.equals(pivot));
    assert(transform().distanceTo(expected) < 1e-10);
    assert.equal(volume.webgpuMaterial, material);
    // CPU field resolution changes replace texture bindings, but must not reset the source pivot.
    layer.density.field.resolution.set(8, 8, 8);
    layer.density.field.data = new Float32Array(512).fill(1);
    layer.density.field.version++;
    volume.update([], owner);
    assert(volume.layers[0].children[1].pivot.value.equals(pivot));
  } finally { owner.destroy(); }
});
