import assert from 'node:assert/strict';
import test from 'node:test';
import { BoxGeometry, Mesh, MeshBasicMaterial, Scene, SphereGeometry } from 'three';
import { FluidCollider, GasSimulation, ParticleSystem, GeometryUpdatePolicy } from '../../build/index.mjs';

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
  assert.equal(wrapper.updatePolicy, GeometryUpdatePolicy.TransformDynamic);
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
  gas.collisionOptions = { world: scene, staticAfter: 2 };
  collect();
  assert.equal(gas.collectedColliders.size, 2, 'effect-owned and renderer-owned meshes are excluded');
  const automatic = gas.collectedColliders.get(selected).collider;
  assert.equal(automatic.updatePolicy, GeometryUpdatePolicy.TransformDynamic);
  gas.collisionElapsed += 2.1;
  collect();
  assert.equal(automatic.updatePolicy, GeometryUpdatePolicy.Static);
  selected.position.x++;
  collect();
  assert.equal(automatic.updatePolicy, GeometryUpdatePolicy.TransformDynamic);
  gas.collisionOptions = undefined;
  collect();
  assert.equal(gas.collectedColliders.size, 0, 'collection is opt-in');
  gas.collisionOptions = { world: scene };
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

test('geometry fluid collider transform sync never runs the inherited CPU voxel bake', () => {
  const system = new ParticleSystem({ renderers: [] });
  const collider = new FluidCollider({ geometry: new BoxGeometry().toNonIndexed(),
    bakedFieldResolution: 96, surfaceThickness: 0.02 });
  collider.getLocalFeather = () => { throw new Error('Geometry-backed occupancy must be baked on the GPU'); };
  collider.syncGPUTransform(system);
  collider.position.x = 1;
  collider.syncGPUTransform(system);
  assert.equal(collider._bakedFieldTexture, undefined);
  collider.geometry.dispose();
  system.dispose();
});

test('custom fluid occupancy retains its CPU predicate bake fallback', () => {
  const system = new ParticleSystem({ renderers: [] });
  const collider = new FluidCollider({ geometry: new BoxGeometry().toNonIndexed(),
    test: () => true, bakedFieldResolution: 2 });
  let samples = 0;
  collider.getLocalFeather = () => { samples++; return 1; };
  collider.syncGPUTransform(system);
  assert.equal(samples, 8);
  assert(collider._bakedFieldTexture);
  collider.geometry.dispose();
  system.dispose();
});

test('closed back-sided receivers contain fluid; sheets and ordinary solids do not invert', async () => {
  const { BackSide, FrontSide, DoubleSide, PlaneGeometry } = await import('three');
  const scene = new Scene();
  const room = new Mesh(new BoxGeometry(8, 4, 8), new MeshBasicMaterial({ side: BackSide }));
  const solid = new Mesh(new BoxGeometry(), new MeshBasicMaterial({ side: DoubleSide }));
  const sheet = new Mesh(new PlaneGeometry(), new MeshBasicMaterial({ side: BackSide }));
  scene.add(room, solid, sheet);
  const gas = new GasSimulation({ collisionOptions: { world: scene } });
  const owner = new ParticleSystem({ modules: [gas], emitters: [], renderers: [] });
  scene.add(owner);
  try {
    gas.collectColliders(owner);
    assert.equal(gas.collectedColliders.get(room).collider.inverted, true);
    assert.equal(gas.collectedColliders.get(solid).collider.inverted, false);
    assert.equal(gas.collectedColliders.get(sheet).collider.inverted, false);
    const wrapper = gas.collectedColliders.get(room).collider;
    const version = wrapper.version;
    room.material.side = FrontSide;
    gas.collectColliders(owner);
    assert.equal(wrapper.inverted, false);
    assert(wrapper.version > version, 'material-side changes invalidate occupancy');
  } finally {
    owner.destroy();
    for (const mesh of [room, solid, sheet]) { mesh.geometry.dispose(); mesh.material.dispose(); }
  }
});
