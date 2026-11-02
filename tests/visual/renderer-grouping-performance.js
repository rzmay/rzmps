import { Vector3 } from 'three';
import { Particle, ParticleSystem, Renderer, ParticleSpatialGrid, createGPUParticleBufferState }
  from '../../packages/rzmps/build/index.mjs';
import { createWebGPURenderer } from '../../apps/demo/src/rendering/createWebGPURenderer.js';

class Capture extends Renderer {
  setup() {} clear() {} destroy() { this.reset(); }
  _update() {}
  _updateGPU(buffers) { this.buffers = buffers; }
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
async function run() {
  const renderer = await createWebGPURenderer({ trackTimestamp: true });
  const system = new ParticleSystem({ gpuProcessing: false, emitters: [], modules: [], renderers: [] });
  system._renderer = renderer;
  let calls = [];
  const individualStages = new URLSearchParams(location.search).has('stages');
  const compute = renderer.compute.bind(renderer);
  renderer.compute = nodes => {
    if (individualStages && Array.isArray(nodes)) {
      nodes.forEach(node => renderer.compute(node));
      return;
    }
    compute(nodes);
    const name = Array.isArray(nodes)
      ? nodes[0]?.name === 'rzmps.grouping.assign' ? 'assignment/aggregate'
        : nodes[0]?.name.startsWith('rzmps.grouping.') ? 'selection' : 'grid'
      : nodes.name || 'grid';
    calls.push({ name,
      uid: renderer.backend.getTimestampUID(nodes) });
  };
  async function measure(update) {
    for (let i = 0; i < 10; i++) { update(); await renderer.resolveTimestampsAsync('compute'); }
    const samples = [];
    for (let i = 0; i < 40; i++) {
      calls = [];
      const start = performance.now();
      update();
      const submitted = performance.now();
      await renderer.backend.device.queue.onSubmittedWorkDone();
      const completed = performance.now();
      await renderer.resolveTimestampsAsync('compute');
      const stages = {};
      for (const { name, uid } of calls) stages[name] = (stages[name] ?? 0) + renderer.backend.getTimestamp(uid);
      samples.push({ cpuMs: submitted - start, completedMs: completed - start,
        gpuMs: Object.values(stages).reduce((a, b) => a + b, 0), stages });
    }
    return { cpuMs: median(samples.map(s => s.cpuMs)), completedMs: median(samples.map(s => s.completedMs)),
      gpuMs: median(samples.map(s => s.gpuMs)),
      stages: Object.fromEntries(Object.keys(samples[0].stages)
        .map(name => [name, median(samples.map(s => s.stages[name]))])) };
  }
  const results = [];
  try {
    for (const [population, capacity, groups] of [[10000, 32768, 18], [10000, 32768, 128],
      [2000, 32768, 512], [10000, 131072, 18]]) {
      const particles = Array.from({ length: population }, (_, i) => new Particle({
        position: new Vector3((i % 100) * 0.125, Math.floor(i / 100) * 0.125, Math.sin(i) * 0.05),
      }));
      const input = createGPUParticleBufferState(particles, capacity);
      // Grouping sees the entire allocated simulation pool, including dead slots.
      input.count = capacity;
      const capture = new Capture({ count: groups });
      const timing = await measure(() => capture.updateGPU(input, system));
      const output = await capture._gpuGrouping.readback();
      const contribution = output.reduce((sum, p) => sum + p.contribution, 0);
      if (contribution !== population) throw new Error(`Lost grouping coverage: ${contribution}/${population}`);
      results.push({ kind: 'grouping', population, capacity, groups, ...timing });
      capture.reset();
      // This grid represents a compact CPU-uploaded population in a larger reserved allocation.
      input.count = population;
      const grid = new ParticleSpatialGrid();
      results.push({ kind: 'grid', population, capacity,
        ...await measure(() => grid.rebuild(renderer, input)) });
      const diagnostics = await grid.readDiagnostics(renderer);
      if (diagnostics.referencedSlots !== population) throw new Error('Lost grid coverage');
      grid.dispose(renderer);
      input.dispose(renderer);
    }
    const info = renderer.backend.device.adapterInfo;
    return { adapter: { vendor: info.vendor, architecture: info.architecture,
      device: info.device, description: info.description },
    timestampQuery: renderer.backend.device.features.has('timestamp-query'), individualStages, samples: 40, results };
  } finally { system.destroy(); renderer.dispose(); }
}
run().then(result => { window.performanceResult = result; }, error => {
  window.performanceResult = { error: error.stack ?? String(error) };
});
