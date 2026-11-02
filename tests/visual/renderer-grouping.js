import { Vector3, Color } from 'three';
import { Renderer, Particle, ParticleSystem, ParticleSpatialGrid, createGPUParticleBufferState, LightRenderer }
  from '../../packages/rzmps/build/index.mjs';
import { IndirectStorageBufferAttribute, StorageBufferAttribute } from 'three/webgpu';
import { Fn, instanceIndex, storage, uniform } from 'three/tsl';
import { createWebGPURenderer } from '../../apps/demo/src/rendering/createWebGPURenderer.js';
const check = (condition, message) => { if (!condition) throw new Error(message); };
class Capture extends Renderer {
  setup() {} clear() {} destroy() { this.reset(); }
  _update(particles) { this.output = particles; }
  _updateGPU(buffers) { this.buffers = buffers; }
}
async function verifyGridRanges(renderer) {
  const particles = Array.from({ length: 65 }, (_, i) => new Particle({
    position: new Vector3((i % 5) * 0.1 - 0.2, Math.floor(i / 5) * 0.02 - 0.1, 0),
  }));
  const input = createGPUParticleBufferState(particles, 4096);
  const grid = new ParticleSpatialGrid({ autoExpand: false });
  let cpuNodes;
  for (const count of [65, 17, 0, 37]) {
    input.count = count;
    grid.rebuild(renderer, input);
    const nodes = grid.buildNodes;
    cpuNodes ??= nodes;
    check(nodes === cpuNodes, 'Changing CPU counts reuses grid pipelines');
    check((await grid.readDiagnostics(renderer)).referencedSlots === count, 'CPU range excludes reserved live slots');
    grid.rebuild(renderer, input);
    check(grid.buildNodes === nodes, 'Changing CPU counts reuses grid pipelines');
    check(nodes.find(node => node.name === 'rzmps.grid.insert').count === count,
      'Grid insert dispatch follows CPU range, not reserved capacity');
  }
  const count = uniform(0, 'uint');
  const dispatch = new IndirectStorageBufferAttribute(new Uint32Array([0, 1, 1]), 1);
  const args = storage(dispatch, 'uint', 3);
  const schedule = Fn(() => { args.element(0).assign(count.add(63).div(64)); })().compute(1);
  const range = { count, dispatch };
  input.count = 65;
  let cached;
  for (const size of [0, 1, 65, 17]) {
    count.value = size;
    renderer.compute(schedule);
    grid.rebuild(renderer, input, undefined, range);
    cached ??= grid.buildNodes;
    check(grid.buildNodes === cached, 'GPU population changes reuse grid pipelines');
    check((await grid.readDiagnostics(renderer)).referencedSlots === size,
      'GPU range supports empty, growing and shrinking populations with exact tail guarding');
  }
  const attribute = new StorageBufferAttribute(new Uint32Array(65), 1);
  const output = storage(attribute, 'uint', 65);
  const visit = grid.computeParticles(particle => {
    output.element(instanceIndex).assign(particle.index.add(1));
  }, range);
  renderer.compute(visit);
  const values = new Uint32Array(await renderer.getArrayBufferAsync(attribute));
  check(values.every((value, i) => value === (i < 17 ? i + 1 : 0)),
    'Shared grid dispatch helper guards partial groups');
  visit.dispose(); schedule.dispose();
  renderer.backend.destroyAttribute(attribute);
  renderer.backend.destroyAttribute(dispatch);
  grid.dispose(renderer);
  grid.rebuild(renderer, input, 'reset');
  check((await grid.readDiagnostics(renderer)).referencedSlots === 65, 'Disposed grids can be rebuilt');
  grid.dispose(renderer); input.dispose(renderer);
}
async function verify() {
  const renderer = await createWebGPURenderer({ antialias: false, forceWebGL: false });
  let maxBindings = 0, dispatches = 0;
  const compute = renderer.backend.compute.bind(renderer.backend);
  renderer.backend.compute = (...args) => { dispatches++; return compute(...args); };
  const createPipeline = renderer.backend.createComputePipeline.bind(renderer.backend);
  renderer.backend.createComputePipeline = (input, ...args) => {
    const code = (input.pipeline ?? input).computeProgram.code;
    maxBindings = Math.max(maxBindings, (code.match(/var<storage/g) ?? []).length);
    return createPipeline(input, ...args);
  };
  const system = new ParticleSystem({
    gpuProcessing: false, simulationSpace: 'world', emitters: [], modules: [], renderers: [],
  });
  system._renderer = renderer;
  const capture = new Capture({ count: 5 });
  const cpu = new Capture({ count: 5 });
  let readbacks = 0;
  system.selectiveReadback = () => { readbacks++; throw new Error('Grouping must not read simulation state'); };
  const counts = [];
  try {
    await verifyGridRanges(renderer);
    for (const [n, k, radius, coincident] of [[37, 5, -1, false], [32, 13, -1, true],
      [15, 1, 0, false], [9, 0, -1, false], [7, 20, -1, false], [1024, 512, -1, true]]) {
      const particles = Array.from({ length: n }, (_, i) => {
        const p = new Particle({
          position: new Vector3(coincident ? 1 : (i % 7) * 0.25, coincident ? 1 : Math.floor(i / 7) * 0.5, 0),
          color: new Color(0.2, 0.4, 0.6), alpha: 0.7, velocity: new Vector3(i, i * 0.5, 0),
        });
        p.id = `id:${String(i).padStart(8, '0')}`; return p;
      });
      const input = createGPUParticleBufferState(particles, n);
      cpu.count = capture.count = k; cpu.groupingRadius = capture.groupingRadius = radius;
      cpu.update(particles, system);
      capture.updateGPU(input, system);
      await renderer.backend.device.queue.onSubmittedWorkDone();
      check(readbacks === 0, 'GPU preprocessing cannot use selective readback');
      // Observation for validation occurs only after grouping and is outside its implementation.
      const groups = capture.buffers === input ? particles : await capture._gpuGrouping.readback();
      check(groups.length === Math.min(n, k), `Wrong GPU K for ${n}/${k}: ${groups.length}`);
      check(groups.every(p => p.position.toArray().every(Number.isFinite)), 'Finite weighted output');
      const energy = groups.reduce((sum, p) => sum + p.contribution, 0);
      check(energy === cpu.output.reduce((sum, p) => sum + p.contribution, 0), `CPU/GPU membership mismatch ${energy}`);
      if (capture.buffers !== input) {
        const scratchBuffer = await renderer.getArrayBufferAsync(capture._gpuGrouping.scratch);
        const words = new Uint32Array(scratchBuffer), values = new Float32Array(scratchBuffer);
        const capacity = capture._gpuGrouping.capacity;
        const layout = capture._gpuGrouping.layout();
        const { heads } = layout;
        const anchors = groups.map((_, g) => words[layout.seeds + g]);
        const seen = new Set();
        groups.forEach((group, g) => {
          let slot = words[heads + g], weight = 0;
          const position = new Vector3(), velocity = new Vector3();
          while (slot !== 0xffffffff) {
            check(!seen.has(slot), 'Each source can contribute only once'); seen.add(slot);
            const d = particles[slot].position.distanceToSquared(particles[anchors[g]].position);
            const nearest = Math.min(...anchors.map(a =>
              particles[slot].position.distanceToSquared(particles[a].position)));
            check(d <= nearest + 0.00001, 'Grid assignment must choose an exact nearest center');
            check(radius < 0 || d <= radius * radius, 'Finite radius must constrain membership');
            const w = 1 / (1 + d / Math.max(1e-12, values[layout.support + g]));
            position.addScaledVector(particles[slot].position, w);
            velocity.addScaledVector(particles[slot].velocity, w);
            weight += w;
            slot = words[capacity * 2 + slot];
          }
          check(group.position.distanceTo(position.divideScalar(weight)) < 0.0001,
            'GPU weighted centroid matches memberships');
          check(group.velocity.distanceTo(velocity.divideScalar(weight)) < 0.0001,
            'GPU weighted velocity matches memberships');
        });
        check(seen.size === energy, 'Reduction preserves every assigned contribution');
      }
      for (let i = 0; i < groups.length; i++) {
        check(Math.min(...cpu.output.map(p => groups[i].position.distanceTo(p.position))) < (coincident ? 0.0001 : 0.8),
          `CPU/GPU centroid mismatch n=${n} k=${k} group ${i}`);
        check(Math.abs(groups[i].alpha - cpu.output[i].alpha) < 0.0001, 'CPU/GPU alpha mismatch');
        check(groups[i].velocity.toArray().every(Number.isFinite), 'Finite GPU velocity');
      }
      if (n === 37) {
        const cachedNodes = capture._gpuGrouping.nodes;
        input.count = 36;
        capture.updateGPU(input, system);
        check(capture._gpuGrouping.nodes === cachedNodes,
          'Population changes reuse grouping pipelines within capacity');
        await renderer.backend.device.queue.onSubmittedWorkDone();
      }
      counts.push(groups.length);
      capture.reset(); input.dispose(renderer);
    }
    // Eligibility is evaluated before K, including tags and dead GPU slots.
    const tagged = Array.from({ length: 40 }, (_, i) => {
      const p = new Particle({ position: new Vector3(i * 0.25, 0, 0), tags: i % 2 ? ['other'] : ['chosen'] });
      p.alive = i % 5 !== 0; return p;
    });
    const taggedInput = createGPUParticleBufferState(tagged, 40, p => p.tags[0] === 'chosen' ? 1 : 2, () => 1);
    system.getGPURendererTagMask = tags => tags ? 1 : undefined;
    capture.tags = ['chosen']; capture.count = 10; capture.ratio = 0.3;
    capture.groupingRadius = -1; capture.children = { count: 2 };
    capture.updateGPU(taggedInput, system);
    await renderer.backend.device.queue.onSubmittedWorkDone();
    const taggedGroups = await capture._gpuGrouping.readback();
    check(taggedGroups.length === 5, 'K uses sixteen eligible live particles before children');
    const states = new Uint32Array(await renderer.getArrayBufferAsync(capture.buffers.attributes.uintData));
    check(Array.from({ length: states.length / 4 }, (_, i) => states[i * 4]).filter(Boolean).length === 15,
      'GPU grouping precedes artistic children');
    check(taggedGroups.reduce((n, p) => n + p.contribution, 0) === 16, 'Tagged population coverage');
    system._gpuBuffers = taggedInput;
    system.quality = 0.5; capture.compensation = 'children';
    capture.updateGPU(taggedInput, system);
    await renderer.backend.device.queue.onSubmittedWorkDone();
    const lodStates = new Uint32Array(await renderer.getArrayBufferAsync(capture.buffers.attributes.uintData));
    check(Array.from({ length: lodStates.length / 4 }, (_, i) => lodStates[i * 4]).filter(Boolean).length === 30,
      'Native GPU LOD compensates the grouped artistic population');
    capture.reset(); system._gpuBuffers = undefined; system.clearParticles(); taggedInput.dispose(renderer);
    system.quality = 1;
    // Compact grouped readback also feeds scene lights, without simulation snapshots.
    const particles = Array.from({ length: 16 }, (_, i) => new Particle({ position: new Vector3(i, 0, 0) }));
    const input = createGPUParticleBufferState(particles);
    const lights = new LightRenderer({ count: 3 });
    lights.updateGPU(input, system);
    while (lights._gpuReadbackPending) await new Promise(resolve => setTimeout(resolve, 10));
    check(lights.lights.filter(l => l.intensity > 0).length === 3, 'GPU grouped lights');
    check(lights.lights.reduce((n, l) => n + l.intensity, 0) === 3, 'GPU grouping preserves per-light intensity');
    check(readbacks === 0, 'Light grouping cannot read simulation snapshots');
    lights.destroy(); input.dispose(renderer);
    // Regression: include dead GPU pool slots and measure completed GPU work,
    // rather than accepting a screenshot after minutes of sorting dispatches.
    const workload = Array.from({ length: 10000 }, (_, i) => new Particle({
      position: new Vector3((i % 100) * 0.125, Math.floor(i / 100) * 0.125, Math.sin(i) * 0.05),
    }));
    const pool = createGPUParticleBufferState(workload, 32768);
    pool.count = 32768;
    const timed = new Capture({ count: 18 });
    for (let i = 0; i < 5; i++) {
      timed.updateGPU(pool, system);
      await renderer.backend.device.queue.onSubmittedWorkDone();
    }
    const times = [], before = dispatches;
    const cachedGridNodes = timed._gpuGrouping.centers.buildNodes;
    for (let i = 0; i < 60; i++) {
      const start = performance.now();
      timed.updateGPU(pool, system);
      await renderer.backend.device.queue.onSubmittedWorkDone();
      times.push(performance.now() - start);
    }
    check(timed._gpuGrouping.centers.buildNodes === cachedGridNodes, 'Spatial grid rebuilds reuse compute graphs');
    const passesPerFrame = (dispatches - before) / times.length;
    check(passesPerFrame > 12 && passesPerFrame < 128, `Bounded spatial-level dispatches: ${passesPerFrame}`);
    check([...timed._gpuGrouping.nodes, ...timed._gpuGrouping.selection]
      .every(n => !/sort|subdivide|histogram/.test(n.name)),
    'No grouping-specific spatial sorting or serial partitioner');
    const particleDispatch = new Uint32Array(await renderer.getArrayBufferAsync(timed._gpuGrouping.particleDispatch));
    const groupDispatch = new Uint32Array(await renderer.getArrayBufferAsync(timed._gpuGrouping.groupDispatch));
    check(particleDispatch[0] === Math.ceil(10000 / 64) && groupDispatch[0] === 1,
      'GPU indirect workgroups follow the live population and group count, rather than pool capacity');
    const sorted = [...times].sort((a, b) => a - b);
    const timing = { population: workload.length, poolSlots: pool.count, groups: 18,
      meanMs: times.reduce((a, b) => a + b) / times.length,
      p95Ms: sorted[Math.floor(sorted.length * 0.95)], passesPerFrame };
    check(timing.meanMs < 100, `GPU grouping must remain responsive: ${JSON.stringify(timing)}`);
    const result = await timed._gpuGrouping.readback();
    check(result.length === 18 && result.reduce((n, p) => n + p.contribution, 0) === 10000,
      'Large GPU population coverage');
    timed.reset();
    const pooledLights = new LightRenderer({ count: 18 });
    pooledLights.updateGPU(pool, system);
    while (pooledLights._gpuReadbackPending) await new Promise(resolve => setTimeout(resolve, 10));
    check(pooledLights.lights.length === 18 && pooledLights.lights.every(light => light.visible),
      'Count caps bound the reserved light pool, whose nodes remain registered');
    check(pooledLights.lights.every(light => light.intensity === 1), 'Group size cannot amplify light intensity');
    pooledLights.destroy(); pool.dispose(renderer);
    check(maxBindings <= 8, `Portable storage binding limit: ${maxBindings}`);
    return { counts, readbacks, maxBindings, timing };
  } finally { capture.reset(); renderer.dispose(); }
}
verify().then(result => {
  window.groupingResult = result;
}, error => {
  window.groupingResult = { error: error.stack ?? String(error) };
});
