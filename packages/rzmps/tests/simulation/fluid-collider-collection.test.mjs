import assert from 'node:assert/strict';
import test from 'node:test';
import { BoxGeometry, Mesh, MeshBasicMaterial, Scene, SphereGeometry } from 'three';
import { FluidCollider, GasSimulation, ParticleSystem, SpatialEffectUpdatePolicy } from '../../build/index.mjs';

test('fluid discovery mirrors collision filters, follows meshes, and preserves source ownership', () => {
  const scene = new Scene();
  const material = new MeshBasicMaterial();
  const geometry = new BoxGeometry();
  const selected = new Mesh(geometry, material);
  const rejected = new Mesh(geometry, material);
  const explicit = FluidCollider.Box({}, 1, 1, 1);
  scene.add(selected, rejected, explicit);
  const gas = new GasSimulation({
    spatialGridOptions: { brickSubdivisions: 1, cellSubdivisions: 1 },
    collisionOptions: { world: scene, objectFilter: mesh => mesh === selected,
      dynamicObjectFilter: () => true },
  });
  const system = new ParticleSystem({ emitters: [], renderers: [], modules: [gas] });
  scene.add(system);
  gas.spatialEffects = [explicit];
  const collect = () => gas.collectColliders(system);
  collect();
  assert.equal(gas.collectedColliders.size, 1);
  const wrapper = gas.collectedColliders.get(selected).collider;
  assert.equal(wrapper.geometry, geometry);
  assert.equal(wrapper.updatePolicy, SpatialEffectUpdatePolicy.TransformDynamic);
  assert.equal(wrapper.canCacheGridOccupancy, true);
  assert.equal(wrapper.parent, null, 'automatic occupancy wrappers never alter the scene hierarchy');
  assert.equal(selected.parent, scene);

  selected.position.set(2, 3, 4);
  collect();
  assert.equal(gas.collectedColliders.get(selected).collider, wrapper, 'rigid motion reuses the baked field');
  wrapper.updateWorldMatrix(true, false);
  assert.deepEqual(wrapper.matrixWorld.elements, selected.matrixWorld.elements);

  const version = wrapper.version;
  geometry.attributes.position.needsUpdate = true;
  collect();
  assert(wrapper.version > version, 'vertex revisions invalidate the solid-field cache');

  gas.collisionOptions = { world: scene, staticObjects: [] };
  collect();
  assert.equal(gas.collectedColliders.size, 0, 'an explicit empty list suppresses automatic scene membership');
  assert.equal(wrapper.geometry, undefined);

  gas.collisionOptions = { dynamicObjects: [selected] };
  collect();
  const sphere = new SphereGeometry();
  selected.geometry = sphere;
  collect();
  assert.equal(gas.collectedColliders.get(selected).collider.geometry, sphere);
  gas.collisionOptions = { world: scene };
  collect();
  assert.equal(gas.collectedColliders.size, 2, 'effect-owned and renderer-owned meshes are excluded');
  selected.removeFromParent();
  collect();
  assert(!gas.collectedColliders.has(selected));

  let disposed = false;
  geometry.addEventListener('dispose', () => { disposed = true; });
  system.destroy();
  assert.equal(disposed, false, 'the simulation never disposes application mesh geometry');
  explicit.geometry.dispose();
  geometry.dispose();
  sphere.dispose();
  material.dispose();
});
