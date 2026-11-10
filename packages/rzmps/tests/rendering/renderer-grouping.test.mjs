import assert from 'node:assert/strict';
import { Vector3, Color } from 'three';
import { Renderer, Particle, ParticleSystem, LightRenderer, Emitter, CompensationMode, createGPUParticleBufferState, createGPUParticleRenderBufferState } from '../../build/index.mjs';
class Capture extends Renderer {
  setup() {} clear() {} destroy() { this.reset(); }
  _update(particles) { this.output = particles; }
}
const system = new ParticleSystem({ gpuProcessing: false, emitters: [], modules: [], renderers: [], simulationSpace: 'world' });
function particle(x, y = 0, z = 0, id = `${x}:${y}:${z}`) {
  const p = new Particle({ position: new Vector3(x, y, z), color: new Color(0.2, 0.4, 0.6), mass: 2, alpha: 0.5 });
  p.id = id; return p;
}
const population = Array.from({ length: 101 }, (_, i) => particle((i % 13) * 0.1, Math.floor(i / 13) * 0.1, i % 3));
// Inactive grouping must not construct helpers or touch spatial system APIs.
class GPUCapture extends Capture {
  _updateGPU(buffers) { this.buffers = buffers; }
}
const spatialGuard = new Proxy({}, {
  get(_target, key) {
    if (key === 'quality') return 1;
    // EventReceiver still resolves receiver identity and batches when grouping is inactive.
    if (key === 'uuid') return system.uuid;
    if (key === 'beginGPUEventExecution') return system.beginGPUEventExecution.bind(system);
    if (key === 'getGPURendererTagMask') return () => undefined;
    throw new Error(`Inactive grouping accessed system.${String(key)}`);
  },
});
for (const options of [{}, { count: -1, ratio: 1 }, { count: Infinity, ratio: 1 },
  { count: 1000, ratio: 1 }, { count: -1, ratio: 0.999 }]) {
  const inactive = new GPUCapture(options);
  assert.equal(inactive._gpuGrouping, undefined, 'Construction does not create GPU spatial helpers');
  inactive.update(population, spatialGuard);
  assert.ok(inactive.output.every((p, i) => p === population[i]), 'CPU identity path preserves original particles');
  const buffers = createGPUParticleBufferState(population);
  inactive.updateGPU(buffers, spatialGuard);
  assert.equal(inactive.buffers, buffers, 'GPU identity path forwards original buffers');
  assert.equal(inactive._gpuGrouping, undefined, 'GPU identity path never constructs spatial helpers');
  // Disabling grouping after prior use must not call a retained helper either.
  let releases = 0;
  inactive._gpuGrouping = { prepare() { throw new Error('Inactive grouping invoked spatial preparation'); }, reset() { releases++; } };
  inactive.updateGPU(buffers, spatialGuard);
  inactive.reset();
  assert.equal(releases, 1);
  assert.equal(inactive._gpuGrouping, undefined, 'Reset releases the old helper and restores lazy state');
  buffers.dispose();
}
const empty = new GPUCapture({ count: 1, ratio: 0.1 });
const emptyBuffers = createGPUParticleBufferState([]);
empty.updateGPU(emptyBuffers, spatialGuard);
assert.equal(empty._gpuGrouping, undefined, 'An empty population does not create spatial helpers');
emptyBuffers.dispose(); empty.reset();
const snapshots = population.map(p => p.snapshot());
const r = new Capture({ count: 7 });
const signature = output => output.map(p => [p.id, ...p.position.toArray(), ...p.color.toArray(), p.alpha, p.mass, p.contribution]);
r.update(population, system);
const expected = signature(r.output);
assert.equal(r.output.length, 7);
assert.equal(r.output.reduce((n, p) => n + p.contribution, 0), population.length);
assert.ok(r.output.every(p => p instanceof Particle && p.contribution > 0));
r.update([...population].reverse(), system);
assert.deepEqual(signature(r.output), expected);
r.update(population.filter((_, i) => i % 2), system);
r.update(population, system);
assert.deepEqual(signature(r.output), expected, 'No historical memberships affect recomputation');
assert.deepEqual(population.map(p => p.snapshot()), snapshots);
for (const [count, ratio, expectedCount] of [[10, 0.25, 10], [-1, 0.25, 25], [Infinity, 0.5, 51], [2.5, 1, 3], [0, 1, 0], [10, 0, 0], [200, 1, 101]]) {
  r.count = count; r.ratio = ratio; r.update(population, system);
  assert.equal(r.output.length, expectedCount);
}
const identical = Array.from({ length: 30 }, (_, i) => particle(1, 1, 1, `id:${i}`));
r.count = 17; r.ratio = 1; r.update(identical, system);
assert.equal(r.output.length, 17);
assert.equal(r.output.reduce((sum, p) => sum + p.contribution, 0), 30);
assert.ok(r.output.every(p => p.position.toArray().every(Number.isFinite)));
r.update([...identical].reverse(), system);
assert.equal(r.output.length, 17);
const clusters = [-100, 100].flatMap(x => Array.from({ length: 20 }, (_, i) => particle(x + i * 0.001)));
r.count = 2; r.update(clusters, system);
assert.ok(r.output[0].position.x * r.output[1].position.x < 0);
assert.deepEqual(r.output.map(p => p.contribution).sort(), [20, 20]);
r.count = 1; r.groupingRadius = 0;
r.update([particle(-10), particle(0), particle(100)], system);
assert.equal(r.output.length, 1);
assert.equal(r.output[0].contribution, 1, 'Finite radius rejects contributions beyond the selected center');
const single = particle(12);
r.count = -1; r.update([single], system);
assert.equal(r.output[0], single);
r.update([], system); assert.equal(r.output.length, 0);
// World-space acceptance includes scale of a locally simulated system.
system.simulationSpace = 'local'; system.scale.set(10, 2, 3); system.updateMatrixWorld(true);
r.count = 1; r.groupingRadius = 2;
r.update([particle(0), particle(1)], system);
assert.equal(r.output[0].contribution, 1);
system.scale.setScalar(1); system.updateMatrixWorld(true); system.simulationSpace = 'world';
r.groupingRadius = -1; r.count = 4; r.children = { count: 2 };
r.update(population, system); assert.equal(r.output.length, 12); assert.equal(r.renderedChildCount, 8);
system.quality = 0.5; r.compensation = CompensationMode.Children;
r.update(population, system); assert.equal(r.output.length, 24); assert.equal(r.renderedChildCount, 20);
system.quality = 1;
const lights = new LightRenderer({ count: 2, ratio: 0.5 });
lights.update(population, system);
assert.equal(lights.lights.length, 2, 'Manual populations preallocate the finite count cap');
assert.ok(lights.lights.every(light => light.visible), 'Reserved light nodes stay registered');
assert.equal(lights.lights.filter(l => l.intensity > 0).length, 2);
assert.equal(lights.lights.reduce((sum, l) => sum + l.intensity, 0), 2, 'Grouping preserves per-light intensity');
const resources = [...lights.lights];
lights.update(population.slice(0, 95), system);
assert.deepEqual(lights.lights, resources, 'Small population changes retain light resources');
for (let frame = 0; frame < 60; frame++) lights.update([], system);
assert.equal(lights.lights.length, 2, 'An idle population retains its predictive reserve');
assert.ok(lights.lights.every(light => light.intensity === 0 && light.visible));
lights.destroy();
// Prediction shares the allocation estimator, without GPU buffer padding.
class ClockedLight extends LightRenderer {
  now = 0;
  getAllocationTime() { return this.now; }
}
const forecast = new ParticleSystem({ gpuProcessing: false, emitters: [new Emitter({
  rate: [2, 10], initialValues: { lifetime: new Set([1, 2]) }, bursts: [{ time: 0, count: 10 }], tags: ['fire'],
})], renderers: [], modules: [] });
assert.equal(forecast.estimateParticleCount(), 30);
assert.equal(forecast.estimateParticleCount(['other']), 0);
const pool = new ClockedLight({ count: 50, ratio: 0.5, allocation: { shrinkDelay: 2, shrinkThreshold: 0.75 } });
pool.setup(forecast);
assert.equal(pool.lights.length, 15, 'Warm allocation uses ceil(min(count, ratio * forecast))');
assert.ok(pool.lights.every(l => l.visible && l.intensity === 0));
const uncapped = new ClockedLight({ count: -1, ratio: 0.5 }); uncapped.setup(forecast);
assert.equal(uncapped.lights.length, 15, 'Unlimited count reserves from the forecast'); uncapped.destroy();
const capped = new ClockedLight({ count: 4, ratio: 0.5 }); capped.setup(forecast);
assert.equal(capped.lights.length, 4); capped.destroy();
const disabled = new ClockedLight({ count: 4, ratio: 0 }); disabled.setup(forecast);
assert.equal(disabled.lights.length, 0); disabled.destroy();
const expanded = new ClockedLight({ count: 4, children: { count: 2 }, compensation: CompensationMode.Children });
forecast.quality = 0.5; expanded.setup(forecast);
assert.equal(expanded.lights.length, 24, 'Forecast reserves grouped parents before artistic and LOD children');
expanded.destroy(); forecast.quality = 1;
pool._update(population.slice(0, 25), forecast);
assert.equal(pool.lights.length, 25, 'Unexpected output grows the pool immediately');
pool._update(population.slice(0, 15), forecast);
pool.now = 1.9; pool._update([], forecast);
assert.equal(pool.lights.length, 25, 'Hysteresis holds capacity until the full delay elapses');
pool.now = 2; pool._update([], forecast);
assert.equal(pool.lights.length, 15, 'Sustained spare capacity shrinks to the forecast');
assert.ok(pool.lights.every(l => l.visible && l.intensity === 0));
pool._update(population.slice(0, 25), forecast); pool._update([], forecast);
pool.now = 3; pool._update(population.slice(0, 20), forecast);
pool.now = 5; pool._update([], forecast);
assert.equal(pool.lights.length, 25, 'Utilization recovery resets the shrink timer');
pool.now = 7; pool._update([], forecast); assert.equal(pool.lights.length, 15);
pool.allocation.shrinkDelay = Infinity;
pool._update(population.slice(0, 25), forecast); pool.now = 100; pool._update([], forecast);
assert.equal(pool.lights.length, 25, 'Infinity disables shrinking');
pool.allocation.shrinkDelay = 0; pool._update([], forecast);
assert.equal(pool.lights.length, 15, 'Zero delay releases sustained surplus immediately');
pool.destroy(); forecast.destroy();
// Sampling results are shared with particle-buffer prediction within a step.
let samples = 0;
const sampled = new ParticleSystem({ gpuProcessing: false, emitters: [new Emitter({ rate: t => { samples++; return 10 * t; }, initialValues: { lifetime: 2 } })], renderers: [], modules: [] });
assert.equal(sampled.estimateParticleCount(), 20);
const sampledCount = samples; sampled.estimateParticleCount(); sampled.gpuSimulation._getInitialGPUBufferCapacity();
assert.equal(samples, sampledCount, 'Renderer reservation does not resample emission curves');
sampled.destroy();
// Moving populations with alternating source order expose the old greedy index jumps.
const stable = new Capture({ count: 2 });
let previous, previousGreedy, motion = 0, greedyMotion = 0;
for (let frame = 0; frame < 30; frame++) {
  const population = Array.from({ length: 80 }, (_, i) => particle(
    (i < 40 ? 4 : 14) + Math.sin(i) * 0.2 + frame * 0.01,
    4 + Math.cos(i) * 0.2, 0, `moving:${i}`,
  ));
  // Deaths and births replace identities at the edge while density keeps moving smoothly.
  if (frame % 3 === 0) population[5].id = `birth:${frame}`;
  if (frame % 2) population.reverse();
  stable.update(population, system);
  const current = stable.output.map(p => p.position.clone());
  // The old LightRenderer always emitted a singleton first, then consumed radius groups.
  const first = population[0].position;
  const remaining = population.slice(1);
  const seed = remaining[0].position;
  const near = remaining.filter(p => p.position.distanceTo(seed) <= 1);
  const greedy = [first, near.reduce((v, p) => v.add(p.position), new Vector3()).divideScalar(near.length)];
  if (previous) current.forEach((p, i) => { motion += p.distanceTo(previous[i]); });
  if (previousGreedy) greedy.forEach((p, i) => { greedyMotion += p.distanceTo(previousGreedy[i]); });
  previous = current; previousGreedy = greedy.map(p => p.clone());
}
assert.ok(motion < greedyMotion * 0.2, `Spatial grouping reduces index-order jumps: ${motion} vs ${greedyMotion}`);
const dense = Array.from({ length: 4096 }, (_, i) => particle(1, 1, 1, `dense:${i}`));
stable.count = 2048; stable.update(dense, system);
assert.equal(stable.output.length, 2048);
assert.equal(stable.output.reduce((n, p) => n + p.contribution, 0), 4096);
console.log('Stateless renderer grouping tests passed.');

// CPU readback must include material-copy channels in the render-buffer stride.
const groupedCapture = new GPUCapture({ count: 2 });
groupedCapture.updateGPU(createGPUParticleBufferState(population), system);
const grouping = groupedCapture._gpuGrouping;
const output = createGPUParticleRenderBufferState(2);
output.ensureCount(2);
const packed = output.attributes.floatData.array;
const stride = packed.length / 2;
for (let index = 0; index < 2; index++) {
  const offset = index * stride;
  packed.set([index + 1, 2, 3, 0.5 + index * 0.1], offset);
  packed.set([1, 0.25, 0.04, 0.3], offset + 12);
  packed.set([4, 5, 6, 7], offset + 16);
  packed.fill(999, offset + 20, offset + stride);
}
grouping.output = output;
grouping.layout = () => ({ meta: 0 });
grouping.renderer = {
  getArrayBufferAsync(attribute) {
    if (attribute === output.attributes.floatData) return Promise.resolve(packed.buffer.slice(0));
    if (attribute === output.attributes.uintData) return Promise.resolve(new Uint32Array([1, 0, 1, 0, 1, 0, 2, 0]).buffer);
    return Promise.resolve(new Uint32Array([8, 2]).buffer);
  },
};
const groups = await grouping.readback();
assert.equal(groups.length, 2);
for (let index = 0; index < groups.length; index++) {
  assert.equal(groups[index].position.x, index + 1);
  assert.ok(Math.abs(groups[index].alpha - (0.5 + index * 0.1)) < 1e-6);
  assert.equal(groups[index].color.r, 1);
  assert.equal(groups[index].color.g, 0.25);
  assert.ok(Math.abs(groups[index].color.b - 0.04) < 1e-6);
  assert.deepEqual(groups[index].velocity.toArray(), [5, 6, 7]);
  assert.equal(groups[index].contribution, 4);
}
