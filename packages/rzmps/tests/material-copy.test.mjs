import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  MaterialCopy, TextureAtlas, MaterialCopySampleMode, Particle, ParticleSystem, MeshRenderer,
  ThreeCollisionBackend, Emitter, createGPUParticleBufferState, GPUEventBufferState, GPUEventType, SpriteRenderer,
} from '../build/index.mjs';

// Ordinary particles, clones, uploads and renderer updates must not allocate appearance vectors.
{
  const ordinary = new Particle();
  const assertLazy = particle => {
    assert.equal(particle._materialCopy, undefined);
    assert.equal(particle._materialCopyU, undefined);
    assert.equal(particle._materialCopyV, undefined);
  };
  assertLazy(ordinary);
  assertLazy(ordinary.clone());
  const upload = new Float32Array(16).fill(9);
  ordinary.writeMaterialCopy(upload, 4);
  assert.deepEqual([...upload], [9, 9, 9, 9, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  assertLazy(ordinary);
  const buffers = createGPUParticleBufferState([ordinary]);
  buffers.upload([ordinary]);
  assertLazy(ordinary);
  buffers.dispose();

  const view = new MeshRenderer();
  const owner = new ParticleSystem({ emitters: [], renderers: view });
  view.update([ordinary], owner);
  assertLazy(ordinary);
  assert.equal(owner._materialCopyRegistry, undefined, 'ordinary rendering does not create a registry');
  assert.equal(view.appearance, undefined);

  // Explicitly registered bindings still activate appearance without an inspection pass over particles.
  const source = new THREE.MeshStandardMaterial({ color: 'red' });
  ordinary.materialCopy.set(owner.materialCopyRegistry.register(source), 0.5, 0.5, MaterialCopySampleMode.Color);
  view.update([ordinary], owner);
  assert.ok(view.appearance);
  ordinary.materialCopyU = new THREE.Vector4(1, 2, 3, 4);
  const clone = ordinary.clone();
  assert.notEqual(clone.materialCopy, ordinary.materialCopy);
  assert.deepEqual(clone.materialCopyU.toArray(), [1, 2, 3, 4]);
  clone.materialCopyU.x++;
  assert.equal(ordinary.materialCopyU.x, 1);
  owner.destroy(); source.dispose();
}

// GPU baking has no CPU image reads; aliases issue one draw, and ordinary frames issue none.
const atlas = new TextureAtlas({ tileSize: 16, padding: 2 });
const source = new THREE.Texture({ width: 64, height: 32 });
assert.equal(atlas.add(source), 0);
assert.equal(atlas.add(source), 0);
let draws = 0;
let allocations = 0;
const previousTarget = {};
const renderer = {
  isWebGPURenderer: true, autoClear: true, current: previousTarget,
  getRenderTarget() { return this.current; },
  setRenderTarget(target) { this.current = target; },
  initRenderTarget() { allocations++; },
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
assert.deepEqual(atlas.rect(0).toArray(), [0.05, 0.1, 0.4, 0.8]);
assert.ok(atlas.sample());
atlas.dispose();
assert.equal(source.version, 0);

// Automatic tiles preserve source detail, grow on late image loads, and cap at the configured limit.
const automatic = new TextureAtlas({ minCapacity: 4 });
const detailed = new THREE.Texture({ width: 525, height: 256 });
automatic.add(detailed);
automatic.update(renderer);
assert.equal(automatic.tileSize, 525);
const beforeGrowth = draws;
automatic.add(new THREE.Texture({ width: 1024, height: 512 }));
automatic.update(renderer);
assert.equal(automatic.tileSize, 1024);
assert.equal(draws - beforeGrowth, 2, 'resolution growth rebakes existing tiles');
automatic.add(new THREE.Texture({ width: 4096, height: 4096 }));
automatic.update(renderer);
assert.equal(automatic.tileSize, 2048);
automatic.dispose();

const capped = new TextureAtlas({ maxTileSize: 256 });
capped.add(detailed);
capped.update();
assert.equal(capped.tileSize, 256);
capped.dispose();

const delayed = new THREE.Texture();
const loading = new TextureAtlas();
loading.add(delayed, 0.5);
loading.update(renderer);
delayed.image = { width: 512, height: 256 };
loading.update(renderer);
assert.equal(loading.tileSize, 256, 'image completion updates resolution without a new tile');
loading.add(delayed, 1);
loading.update(renderer);
assert.equal(loading.tileSize, 512, 'aliases retain the highest requested quality');
loading.add(delayed, 0.25);
loading.update(renderer);
assert.equal(loading.tileSize, 512);
loading.dispose();

const limited = new TextureAtlas();
limited.add(detailed);
renderer.backend = { device: { limits: { maxTextureDimension2D: 1024 } } };
limited.update(renderer);
assert.equal(limited.target.width, 1024);
assert.equal(limited.tileSize, 508, 'padded atlas respects the hardware texture limit');
delete renderer.backend;
limited.dispose();
assert.throws(() => new TextureAtlas({ maxTileSize: 0 }), RangeError);
assert.throws(() => new TextureAtlas({ maxTileSize: Infinity }), RangeError);
assert.throws(() => new TextureAtlas().add(detailed, 0), RangeError);
for (const textureCopyQuality of [0, -1, 2, NaN]) {
  assert.throws(() => new MeshRenderer({ textureCopyQuality }), RangeError);
}
for (const textureCopyQuality of [1, 0.5]) {
  const view = new MeshRenderer({ textureCopyQuality });
  const system = new ParticleSystem({ emitters: [], renderers: view });
  const material = new THREE.MeshStandardMaterial({ map: detailed });
  system.materialCopyRegistry.register(material);
  view.enableMaterialCopy(system.materialCopyRegistry);
  view.appearance.sync(undefined, 0, renderer);
  assert.equal(view.appearance.atlases[0].tileSize, Math.ceil(525 * textureCopyQuality));
  assert.equal(detailed.image.width, 525, 'copy quality does not resize the borrowed source');
  system.destroy(); material.dispose();
}
detailed.dispose();

// The first source reserves two cells; the second keeps GPU storage, UVs and the first bake intact.
const reserved = new TextureAtlas({ tileSize: 16, padding: 2 });
reserved.update(renderer);
assert.equal(reserved.target.width, 1, 'empty channels retain their unallocated placeholder');
reserved.add(new THREE.Texture({ width: 4, height: 4 }));
reserved.update(renderer);
const firstRect = reserved.rect(0).toArray();
const firstSize = [reserved.target.width, reserved.target.height];
const firstDraws = draws;
reserved.add(new THREE.Texture({ width: 4, height: 4 }));
reserved.update(renderer);
assert.deepEqual([reserved.target.width, reserved.target.height], firstSize);
assert.deepEqual(reserved.rect(0).toArray(), firstRect);
assert.equal(draws - firstDraws, 1);
reserved.dispose();

// An explicit minimum allocates once while empty, then accepts four sources without resizing or rebaking.
const preallocated = new TextureAtlas({ tileSize: 16, padding: 2, minCapacity: 4 });
const allocationsBefore = allocations;
const drawsBefore = draws;
preallocated.update(renderer);
assert.equal(allocations, allocationsBefore + 1);
assert.equal(draws, drawsBefore);
assert.deepEqual([preallocated.target.width, preallocated.target.height], [40, 40]);
let originalRect;
for (let index = 0; index < 4; index++) {
  preallocated.add(new THREE.Texture({ width: 4, height: 4 }));
  preallocated.update(renderer);
  originalRect ??= preallocated.rect(0).toArray();
  assert.deepEqual(preallocated.rect(0).toArray(), originalRect);
  assert.equal(allocations, allocationsBefore + 1);
  assert.equal(draws - drawsBefore, index + 1);
}
preallocated.dispose();
assert.throws(() => new TextureAtlas({ minCapacity: -1 }), RangeError);
assert.throws(() => new TextureAtlas({ minCapacity: Infinity }), RangeError);
assert.throws(() => new MeshRenderer({ atlasOptions: { minCapacity: NaN } }), RangeError);
const copyView = new MeshRenderer({ atlasOptions: { minCapacity: 4 } });
const copySystem = new ParticleSystem({ emitters: [], renderers: copyView });
copyView.enableMaterialCopy(copySystem.materialCopyRegistry);
assert.ok(copyView.appearance.atlases.every(atlas => atlas.minCapacity === 4 && atlas.grid.x * atlas.grid.y === 4));
copySystem.destroy();

// The same options configure atlases for ordinary sprite choices and mesh source palettes.
const choiceOptions = { minCapacity: 4, tileSize: 16, padding: 3 };
const choiceTextures = [new THREE.Texture({ width: 4, height: 4 }), new THREE.Texture({ width: 4, height: 4 })];
const choiceSprites = new SpriteRenderer(choiceTextures, { atlasOptions: choiceOptions });
assert.equal(choiceSprites.textureAtlas.minCapacity, 4);
assert.equal(choiceSprites.textureAtlas.tileSize, 16);
assert.equal(choiceSprites.textureAtlas.padding, 3);
choiceSprites.destroy();
choiceTextures.forEach(texture => texture.dispose());
const choiceGeometry = [new THREE.BoxGeometry(), new THREE.SphereGeometry()];
const choiceMeshes = new MeshRenderer({ geometry: choiceGeometry, atlasOptions: choiceOptions });
assert.ok(choiceMeshes.batch.appearance.atlases.every(atlas =>
  atlas.minCapacity === 4 && atlas.tileSize === 16 && atlas.padding === 3));
choiceMeshes.destroy();
choiceGeometry.forEach(geometry => geometry.dispose());


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
  modules: new MaterialCopy(), renderers: debrisView });
const parent = new ParticleSystem({ emitters: [], renderers: [] });
parent.addSubSystem(child, { emitOnCollision: true });
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
floats.set([11, 0.2, 0.3, 0], 16 * 4);
floats.set([9, 0.4, 0.5, 0], 19 * 4);
floats.set([2, 0, 0, 0], 20 * 4);
floats.set([0, 0, 3, 0], 21 * 4);
const batch = await events.readback({
  getArrayBufferAsync: async attribute => attribute.array.buffer.slice(0),
}, () => undefined, undefined, id => id === 9 ? materials[0] : undefined);
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
// Shared shader helpers deduplicate definitions and reject conflicting registrations.
const helpers = new MeshRenderer({ materialComposite: (_source, dest, context) => {
  context.function('tint', 'vec3 tint(vec3 c) { return c; }');
  context.function('tint', 'vec3 tint(vec3 c) { return c; }');
  return { color: `tint(${dest.color})` };
} });
const helperSystem = new ParticleSystem({ emitters: [], renderers: helpers });
helpers.enableMaterialCopy(helperSystem.materialCopyRegistry, {});
const shader = () => ({ ...THREE.ShaderLib.standard,
  uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.standard.uniforms) });
const compiled = shader();
helpers.appearance.shader(compiled, true);
assert.equal(compiled.fragmentShader.match(/vec3 tint\(/g).length, 1);
const other = new MeshRenderer();
other.enableMaterialCopy(helperSystem.materialCopyRegistry, {});
assert.notEqual(helpers.instances.material.customProgramCacheKey(), other.instances.material.customProgramCacheKey());
helpers.materialComposite = (_source, _dest, context) => {
  context.function('tint', 'vec3 tint(vec3 c) { return c; }');
  context.function('tint', 'vec3 tint(vec3 c) { return c * 0.5; }');
  return {};
};
assert.throws(() => helpers.appearance.shader(shader(), true), /Conflicting material composite function/);
helperSystem.destroy();
other.destroy();
console.log('material-copy tests passed');
