import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  TextureAtlas, MaterialCopySampleMode, Particle, ParticleSystem, MeshRenderer,
  ThreeCollisionBackend, Emitter, createGPUParticleBufferState, GPUEventBufferState, GPUEventType, SpriteRenderer,
} from '../build/index.mjs';

// GPU baking has no CPU image reads; aliases issue one draw, and ordinary frames issue none.
const atlas = new TextureAtlas({ tileSize: 16, padding: 2 });
const source = new THREE.Texture({ width: 64, height: 32 });
assert.equal(atlas.add(source), 0);
assert.equal(atlas.add(source), 0);
let draws = 0;
const previousTarget = {};
const renderer = {
  isWebGPURenderer: true, autoClear: true, current: previousTarget,
  getRenderTarget() { return this.current; },
  setRenderTarget(target) { this.current = target; },
  initRenderTarget() {},
  render() { draws++; },
};
atlas.update(renderer);
assert.equal(draws, 1);
atlas.update(renderer);
assert.equal(draws, 1);
atlas.invalidate(source);
atlas.update(renderer);
assert.equal(draws, 2);
assert.equal(renderer.current, previousTarget);
assert.equal(renderer.autoClear, true);
assert.deepEqual(atlas.rect(0).toArray(), [0.1, 0.1, 0.8, 0.8]);
assert.ok(atlas.sample());
atlas.dispose();
assert.equal(source.version, 0);

// Adding a source into an unused cell must retain already baked tiles.
const growing = new TextureAtlas();
for (let i = 0; i < 8; i++) growing.add(new THREE.Texture({ width: 4, height: 4 }));
growing.update(renderer);
const bakedDraws = draws;
growing.add(new THREE.Texture({ width: 4, height: 4 }));
growing.update(renderer);
assert.equal(draws - bakedDraws, 1);
growing.dispose();

const world = new THREE.Scene();
const materials = [new THREE.MeshStandardMaterial({ color: 'red' }),
  new THREE.MeshStandardMaterial({ color: 'blue' })];
const meshes = materials.map((material, i) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 0.2, 2), material);
  mesh.position.x = i ? 2 : -2;
  world.add(mesh);
  return mesh;
});
const backend = new ThreeCollisionBackend({ world });
backend.update(0);
const hitAt = x => backend.collide({ particle: new Particle({ mass: 1 }),
  start: new THREE.Vector3(x, 0.4, 0), end: new THREE.Vector3(x, 0, 0),
  velocity: new THREE.Vector3(0, -1, 0), radius: 0.1 });
const red = hitAt(-2);
const blue = hitAt(2);
assert.equal(red.object, meshes[0]);
assert.equal(blue.object, meshes[1]);
assert.equal(red.material, materials[0]);
assert.ok(red.surface);
assert.ok(Math.abs(red.surface.uv.x - 0.5) < 1e-5);


const debrisView = new MeshRenderer({ materialOptions: { roughness: 1, metalness: 1 } });
const child = new ParticleSystem({ duration: 1, looping: false,
  emitters: new Emitter({ rate: 0, bursts: [{ time: 0, count: 1 }], initialValues: { lifetime: 10 } }),
  renderers: debrisView });
const parent = new ParticleSystem({ emitters: [], renderers: [] });
parent.addSubSystem(child, { emitOnCollision: true, copyCollisionMaterial: true });
const trigger = new Particle({ lifetime: 10 });
const redID = parent.materialCopyRegistry.register(red.material);
const blueID = parent.materialCopyRegistry.register(blue.material);
assert.notEqual(redID, blueID);
parent.notifyCollision(trigger, red);
parent.advanceFrames(1, 1 / 60);
assert.equal(child.particles.length, 1);
assert.equal(child.particles[0].materialCopy.x, redID);
parent.notifyCollision(trigger, blue);
parent.advanceFrames(1, 1 / 60);
assert.equal(child.particles.length, 2);
assert.equal(child.particles[0].materialCopy.x, redID);
assert.equal(child.particles[1].materialCopy.x, blueID);
const particle = child.particles[0];
particle.lodPriority = 0.37;
const clone = particle.clone();
clone.materialCopyU.x += 1;
assert.notEqual(particle.materialCopyU.x, clone.materialCopyU.x);
const buffers = createGPUParticleBufferState([particle], 1);
assert.equal(buffers.attributes.uintData.array[3], Math.floor(0.37 * 4294967296));
assert.ok(buffers.attributes.floatData.array.includes(redID));
assert.equal(MaterialCopySampleMode.UVPatch, 0);
parent.destroy();
backend.destroy?.();
meshes.forEach(mesh => { mesh.geometry.dispose(); mesh.material.dispose(); });

// Collision source metadata must not replace the colliding particle's own inherited appearance.
const events = new GPUEventBufferState(1);
events.counterAttribute.array[0] = 1;
const floats = events.floatAttribute.array;
const uints = new Uint32Array(floats.buffer);
uints.set([GPUEventType.Collision, 0, 1, 0], 14 * 4);
floats.set([11, 0.2, 0.3, 0], 15 * 4);
floats.set([9, 0.4, 0.5, 0], 18 * 4);
floats.set([2, 0, 0, 0], 19 * 4);
floats.set([0, 0, 3, 0], 20 * 4);
const batch = await events.readback({
  getArrayBufferAsync: async attribute => attribute.array.buffer.slice(0),
}, () => undefined, id => id === 9 ? materials[0] : undefined);
assert.equal(batch.events[0].particle.materialCopy.x, 11);
assert.equal(batch.events[0].collision.material, materials[0]);
assert.equal(batch.events[0].collision.materialSourceId, 9);
assert.deepEqual(batch.events[0].collision.surface.u.toArray(), [2, 0, 0]);
events.dispose();

const alternate = new THREE.Texture({ width: 16, height: 16 });
const spriteList = new SpriteRenderer([source, source, alternate], { textureIndex: 1 });
assert.equal(spriteList.textureAtlas.sources.length, 2);
assert.equal(spriteList.getParticleFrame(new Particle()), 0);
spriteList.textureIndex = 2;
assert.equal(spriteList.getParticleFrame(new Particle()), 1);
spriteList.destroy();
assert.throws(() => new TextureAtlas({ tileSize: NaN }), RangeError);
console.log('material-copy tests passed');
