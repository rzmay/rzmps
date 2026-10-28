import assert from 'node:assert/strict';
import * as THREE from 'three';
import { float, Fn } from 'three/tsl';
import { Renderer, Particle, ParticleSystem, Emitter, Module, CompensationMode, TrailRenderer, createGPUParticleBufferState } from '../build/index.mjs';

class Capture extends Renderer {
  output = [];
  setup() {}
  _update(particles) { this.output = particles; }
  clear() {}
  destroy() {}
}
const camera = new THREE.PerspectiveCamera();
function system(options = {}) {
  const s = new ParticleSystem({ gpuProcessing: false, emitters: [], modules: [], renderers: [], gravityModifier: 0, ...options });
  s._camera = camera;
  return s;
}
const root = new Particle({ position: new THREE.Vector3(1, 2, 3), scale: new THREE.Vector3(2, 3, 4), alpha: 0.8, lifetime: 10 });
root.id = 'root';
assert.equal(root.parent, null);
assert.equal(root.root, root);
assert.equal(root.isChild, false);
const s = system();
const renderer = new Capture({ children: { count: 3, radius: 2, scale: 0.8, alpha: 0.7 } });
renderer.update([root], s);
assert.equal(renderer.output.length, 4);
assert.equal(renderer.renderedChildCount, 3);
const first = renderer.output.slice(1).map(p => ({ id: p.id, position: p.position.toArray() }));
for (const p of renderer.output.slice(1)) {
  assert.equal(p.parent, root);
  assert.equal(p.root, root);
  assert.equal(p.isChild, true);
  assert.ok(p.position.distanceTo(root.position) <= 2);
  assert.ok(p.scale.distanceTo(new THREE.Vector3(1.6, 2.4, 3.2)) < 1e-12);
  assert.ok(Math.abs(p.alpha - 0.56) < 1e-12);
  assert.equal(p.velocity, root.velocity);
  assert.equal(p.color, root.color);
  assert.equal(p.rotation, root.rotation);
  assert.notEqual(p.position, root.position);
  assert.notEqual(p.scale, root.scale);
}
assert.equal(root.velocity.x, 0);
root.time = 0.9;
renderer.update([root], s);
assert.deepEqual(renderer.output.slice(1).map(p => ({ id: p.id, position: p.position.toArray() })), first);
const offsets = renderer.output.slice(1).map(p => p.position.toArray());
renderer.children.randomizeAlpha = 0.8;
renderer.update([root], s);
assert.deepEqual(renderer.output.slice(1).map(p => p.position.toArray()), offsets);
assert.deepEqual(root.scale.toArray(), [2, 3, 4]);
assert.equal(root.alpha, 0.8);

const disabled = new Capture({ generateChildren: false, children: { count: () => {
  throw new Error('Disabled children must not evaluate counts');
} }, compensation: CompensationMode.Children });
s.quality = 0.5;
disabled.update([root], s);
assert.deepEqual(disabled.output, [root]);
assert.equal(disabled.renderedChildCount, 0);
disabled.compensation = CompensationMode.Size;
disabled.update([root], s);
assert.ok(Math.abs(disabled.output[0].scale.x - root.scale.x * Math.sqrt(2)) < 1e-12);
s.quality = 1;

// Radial curves use independent deterministic random streams and configurable easing.
const radial = new Capture({ children: { count: 1, radius: 3, scale: [1, 0], alpha: [0, 1], radialFalloff: t => t * t } });
radial.update([root], s);
const child = radial.output[1];
const d = child.position.distanceTo(root.position) / 3;
assert.ok(Math.abs(child.scale.x / root.scale.x - (1 - d * d)) < 1e-12);
assert.ok(Math.abs(child.alpha / root.alpha - d * d) < 1e-12);
radial.children.radius = 0;
radial.update([root], s);
assert.deepEqual(radial.output[1].position.toArray(), root.position.toArray());
assert.deepEqual(radial.output[1].scale.toArray(), root.scale.toArray());

// Variation settings do not shift another property's deterministic random draws.
const varied = new Capture({ children: {
  count: 20, radius: 2, scale: [0.2, 1], alpha: [0.2, 1], randomizeScale: 0.6, randomizeAlpha: 0.8,
} });
const childValues = () => varied.output.slice(1).map(p => ({
  id: p.id, position: p.position.toArray(), scale: p.scale.toArray(), alpha: p.alpha,
}));
varied.update([root], s);
const variedValues = childValues();
varied.children.randomizeScale = 0;
varied.update([root], s);
const withoutScaleVariation = childValues();
assert.deepEqual(withoutScaleVariation.map(p => p.alpha), variedValues.map(p => p.alpha));
assert.deepEqual(withoutScaleVariation.map(p => p.position), variedValues.map(p => p.position));
assert.notDeepEqual(withoutScaleVariation.map(p => p.scale), variedValues.map(p => p.scale));
varied.children.randomizeScale = 0.6;
varied.children.randomizeAlpha = 0;
varied.update([root], s);
const withoutAlphaVariation = childValues();
assert.deepEqual(withoutAlphaVariation.map(p => p.scale), variedValues.map(p => p.scale));
assert.notDeepEqual(withoutAlphaVariation.map(p => p.alpha), variedValues.map(p => p.alpha));
varied.children.randomizeAlpha = 0.8;
varied.update([root], s);
assert.deepEqual(childValues(), variedValues);

const variable = new Capture({ children: { count: [0, 6] } });
const parents = Array.from({ length: 200 }, (_, i) => { const p = new Particle(); p.id = `p${i}`; return p; });
variable.update(parents, s);
const ids = variable.output.map(p => p.id).sort();
parents.forEach(p => { p.time = 0.5; });
variable.update(parents.toReversed(), s);
assert.deepEqual(variable.output.map(p => p.id).sort(), ids);
assert.ok(new Set(parents.map(p => variable.output.filter(c => c.parent === p).length)).size > 1);

s.quality = 0.5;
const compensated = new Capture({ children: { count: 2, radius: 0.5, scale: 0.6, alpha: 0.4 }, compensation: CompensationMode.Children });
compensated.update([root], s);
assert.equal(compensated.output.length, 6);
assert.equal(compensated.renderedChildCount, 5);
assert.equal(new Set(compensated.output.map(p => p.id)).size, 6);
assert.deepEqual(compensated.output.map(p => p.id), [
  'root', 'root[0]', 'root[1]', 'root[2]', 'root[0][0]', 'root[1][0]',
]);
assert.equal(compensated.output.filter(p => p.parent?.isChild).length, 2);
for (const p of compensated.output.slice(3)) {
  assert.equal(p.root, root);
  assert.equal(p.scale, p.parent.scale);
  assert.equal(p.alpha, p.parent.alpha);
}
s.quality = 0.4;
compensated.update(parents, s);
const lowQualityIDs = new Set(compensated.output.map(p => p.id));
s.quality = 0.5;
compensated.update(parents, s);
for (const p of compensated.output) assert.ok(lowQualityIDs.has(p.id));
s.quality = 0;
compensated.update([root], s);
assert.equal(compensated.output.length, 0);
assert.equal(compensated.renderedChildCount, 0);
s.quality = 0.25;
const size = new Capture({ compensation: CompensationMode.Size });
size.update([root], s);
assert.deepEqual(size.output[0].scale.toArray(), [4, 6, 8]);
assert.deepEqual(root.scale.toArray(), [2, 3, 4]);
const sizedChildren = new Capture({ children: { count: 2 }, compensation: CompensationMode.Size });
sizedChildren.update([root], s);
for (const p of sizedChildren.output) assert.deepEqual(p.scale.toArray(), [4, 6, 8]);
assert.deepEqual(root.scale.toArray(), [2, 3, 4]);
assert.equal(sizedChildren.output[0].parent, null);
assert.equal(sizedChildren.output[1].parent, root);

// Visual children share inherited attributes and own only their modified vectors.
s.quality = 1;
const cloned = new Capture({ children: { count: 2, radius: 1 } });
const source = new Particle({ lifetime: 100, tags: ['original'] });
source.id = 'source';
cloned.update([source], s);
const firstChild = cloned.output[1];
assert.equal(firstChild.id, 'source[0]');
assert.equal(firstChild.velocity, source.velocity);
assert.equal(firstChild.tags, source.tags);
assert.equal(firstChild.color, source.color);
assert.equal(firstChild.scale, source.scale);
assert.notEqual(firstChild.position, source.position);
firstChild.position.x = 99;
assert.equal(source.position.x, 0);
source.position.x = 7;
source.alpha = 0.25;
cloned.update([source], s);
assert.notEqual(cloned.output[1], firstChild);
assert.equal(cloned.output[1].id, firstChild.id);
assert.equal(cloned.output[1].velocity.x, source.velocity.x);
assert.equal(cloned.output[1].alpha, 0.25);

// Spacing belongs to the system, uses bounded octree samples, and is shared by views.
const spatial = system(); spatial.quality = 0.5;
const cluster = [0, 0.2, 100, 100.2].map((x, i) => {
  const p = new Particle({ position: new THREE.Vector3(x, 0, 0), lifetime: 100 });
  p.id = `cluster-${i}`; return p;
});
spatial.particles = cluster;
const firstView = new Capture({ compensation: CompensationMode.Children });
const secondView = new Capture({ compensation: CompensationMode.Children });
firstView.update(cluster, spatial);
const tree = spatial.particleOctree;
assert.ok(tree);
assert.ok(Math.abs(spatial.getParticleSpacing(cluster[0]) - 0.1) < 1e-12);
let rebuilds = 0;
const rebuild = tree.rebuild.bind(tree);
tree.rebuild = (...args) => { rebuilds++; return rebuild(...args); };
secondView.update(cluster, spatial);
assert.equal(spatial.particleOctree, tree);
assert.equal(rebuilds, 0, 'a second renderer reuses the system spatial data');
const priorSpacing = spatial.getParticleSpacing(cluster[0]);
cluster[1].position.x = 5;
spatial._renderFrameToken = {};
firstView.update(cluster, spatial);
assert.equal(rebuilds, 0, 'cached roots do not require another tree rebuild');
assert.equal(spatial.getParticleSpacing(cluster[0]), priorSpacing, 'spacing is stable over root lifetime');
const reborn = cluster[0].clone(); reborn.id = 'new-generation';
spatial.particles.push(reborn);
assert.ok(Number.isFinite(spatial.getParticleSpacing(reborn)));
assert.equal(rebuilds, 1, 'new roots refresh the shared tree once');
spatial.clearParticles();
assert.equal(spatial.particleOctree, undefined);
assert.equal(spatial._particleSpacing.size, 0);

// CPU simulation compacts dead and expired particles before renderer preprocessing.
const liveView = new Capture({ children: { count: 1 } });
const liveSystem = system({ renderers: liveView });
const dead = new Particle({ lifetime: 100 }); dead.alive = false;
const expired = new Particle({ lifetime: 0 });
const survivor = new Particle({ lifetime: 100 }); survivor.id = 'survivor';
liveSystem.particles.push(dead, expired, survivor);
liveSystem.advanceFrames(1);
assert.deepEqual(liveSystem.particles, [survivor]);
assert.deepEqual(liveView.output.map(p => p.id), ['survivor', 'survivor[0]']);

// Unified LOD culls before modules, never dispatches death, and recovers only by emission.
camera.position.set(20, 0, 0);
let processed = 0, deaths = 0;
const population = system({ lod: { distance: 10, quality: 0.5, maxLevel: 1 }, modules: new Module(() => { processed++; }) });
population.onDeath(() => deaths++);
const keep = new Particle({ lifetime: 100 }); keep.lodPriority = 0.1;
const remove = new Particle({ lifetime: 100 }); remove.lodPriority = 0.7;
population.particles.push(keep, remove);
population.advanceFrames(1);
assert.equal(population.quality, 0.5);
assert.deepEqual(population.particles, [keep]);
assert.equal(remove.alive, false);
assert.equal(processed, 1);
assert.equal(deaths, 0);
population.advanceFrames(5);
assert.equal(processed, 6);
camera.position.set(0, 0, 0);
population.advanceFrames(1);
assert.equal(population.quality, 1);
assert.deepEqual(population.particles, [keep]);

camera.position.set(20, 0, 0);
const burst = system({ lod: { distance: 10, quality: 0.5, maxLevel: 1 }, emitters: new Emitter({ rate: 0, bursts: [{ time: 0, count: 10 }], initialValues: { lifetime: 100 } }) });
burst.advanceFrames(1);
assert.equal(burst.particles.length, 5);
assert.ok(burst.particles.every(p => p.lodPriority < 0.5));
const fractional = new Emitter({ rate: 0, bursts: [{ time: 0, count: 1 }, { time: 0.1, count: 1 }] });
const emitted = [];
fractional.update(emitted, { time: 0 }, burst);
fractional.update(emitted, { time: 0.2 }, burst);
assert.equal(emitted.length, 1);
const buffers = createGPUParticleBufferState(burst.particles, 8);
for (let i = 0; i < burst.particles.length; i++) assert.ok(Math.abs(buffers.attributes.uintData.array[i * 4 + 3] / 4294967296 - burst.particles[i].lodPriority) < 1e-9);
assert.ok(buffers.particle.id.isNode);
assert.equal(buffers.particle.parent, null);
assert.ok(buffers.particle.isChild.isNode);

// Trail history keys follow stable child identity, even when another parent's children disappear.
const trails = new TrailRenderer({ texture: new THREE.Texture(), minimumVertexDistance: 0, children: { count: 1, radius: 0.1 } });
s.quality = 1;
const other = root.clone(); other.id = 'other';
trails.update([root, other], s, 0.1);
const history = trails.trails.get('other[0]');
assert.ok(history);
root.position.x += 1; other.position.x += 1;
trails.update([other, root], s, 0.1);
assert.equal(trails.trails.get('other[0]'), history);
trails.update([other], s, 0.1);
assert.equal(trails.trails.get('other[0]'), history);
assert.equal(trails.trails.has('root[0]'), false);
assert.equal(s.particles.length, 0);
trails.reset(); trails.destroy();
// Known TSL constants use their real count; opaque expressions reserve the
// device-bounded aggregate arena without assuming a per-parent count ceiling.
class GPUCapture extends Capture { _updateGPU(buffers) { this.buffers = buffers; } }
const noChildrenGPU = new GPUCapture({ generateChildren: false, children: { count: 1000 },
  compensation: CompensationMode.Children });
noChildrenGPU._gpuChildren.prepare = () => { throw new Error('Disabled children must skip GPU allocation'); };
noChildrenGPU.updateGPU(buffers, s);
assert.equal(noChildrenGPU.buffers, buffers);
assert.equal(noChildrenGPU.renderedChildCount, 0);
const gpuSystem = system();
gpuSystem._renderer = { compute() {}, backend: { device: { limits: { maxStorageBufferBindingSize: 1048576 } } } };
const inactiveCompensationGPU = new GPUCapture({ compensation: CompensationMode.Children });
inactiveCompensationGPU.updateGPU(buffers, gpuSystem);
assert.equal(inactiveCompensationGPU.buffers, buffers);
const constantGPU = new GPUCapture({ children: { count: float(100) } });
constantGPU.updateGPU(buffers, gpuSystem);
assert.ok(constantGPU.buffers.capacity >= buffers.count * 101);
assert.notEqual(constantGPU.buffers, buffers);
let childCounterReads = 0;
gpuSystem._renderer.getArrayBufferAsync = async () => {
  childCounterReads++;
  return new Uint32Array([4, 3, 0, 0]).buffer;
};
assert.equal(childCounterReads, 0, 'Rendering alone does not request child diagnostics');
assert.equal(constantGPU.renderedChildCount, 0, 'GPU count is asynchronous');
await new Promise(resolve => setImmediate(resolve));
assert.equal(constantGPU.renderedChildCount, 7, 'Count includes artistic and LOD children');
assert.equal(childCounterReads, 1, 'Repeated reads reuse throttled diagnostics');
constantGPU.generateChildren = false;
constantGPU.updateGPU(buffers, gpuSystem);
assert.equal(constantGPU.buffers, buffers, 'Runtime disable bypasses the cached expanded view');
assert.equal(constantGPU.renderedChildCount, 0);
constantGPU.generateChildren = true;
constantGPU.children.count = 0;
constantGPU.updateGPU(buffers, gpuSystem);
assert.equal(constantGPU.renderedChildCount, 0, 'Disabling children hides the cached GPU count immediately');
constantGPU.reset();
const opaqueGPU = new GPUCapture({ children: { count: Fn(() => float(100))() } });
opaqueGPU.updateGPU(buffers, gpuSystem);
assert.equal(opaqueGPU.buffers.capacity, 1048576 / 64);
opaqueGPU.reset();
// GPU spacing is system-owned and dispatched once per frame across renderers.
gpuSystem.quality = 0.5;
gpuSystem._gpuBuffers = buffers;
let spacingPasses = 0;
gpuSystem._renderer.compute = node => { if (node.name === 'rzmps.spacing') spacingPasses++; };
const gpuA = new GPUCapture({ compensation: CompensationMode.Children });
const gpuB = new GPUCapture({ compensation: CompensationMode.Children });
gpuA.updateGPU(buffers, gpuSystem);
const sharedSpacing = gpuSystem._gpuParticleSpacing.storage;
gpuB.updateGPU(buffers, gpuSystem);
assert.equal(gpuSystem._gpuParticleSpacing.storage, sharedSpacing);
assert.equal(gpuA._gpuChildren.spacing, sharedSpacing);
assert.equal(gpuB._gpuChildren.spacing, sharedSpacing);
assert.equal(spacingPasses, 1);
gpuSystem._renderFrameToken = {};
gpuB.updateGPU(buffers, gpuSystem);
assert.equal(spacingPasses, 2);
gpuA.reset(); gpuB.reset();
assert.equal(gpuSystem._gpuParticleSpacing.storage, sharedSpacing, 'renderers do not destroy system spacing');
gpuSystem.clearParticles();
assert.equal(gpuSystem._gpuParticleSpacing, undefined);
console.log('Renderer children and unified population LOD tests passed.');
