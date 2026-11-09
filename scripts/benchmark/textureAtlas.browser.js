import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { TextureAtlas } from '@rzmps/rzmps';

const stats = values => {
  const sorted = values.toSorted((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.floor(sorted.length * 0.95)] };
};

window.runAtlasBenchmark = async backend => {
  const renderer = backend === 'webgpu' ? new WebGPURenderer() : new THREE.WebGLRenderer();
  renderer.setSize(32, 32);
  if (backend === 'webgpu') {
    await renderer.init();
    if (!renderer.backend.isWebGPUBackend) throw new Error('Native WebGPU unavailable');
  }

  // Completion includes queue/driver overhead. This is wall time, not a GPU timestamp query.
  const finish = backend === 'webgpu'
    ? () => renderer.backend.device.queue.onSubmittedWorkDone()
    : () => { renderer.getContext().finish(); };
  const results = [];

  for (const count of [8, 32, 128]) {
    const sources = Array.from({ length: count }, (_, i) => {
      const data = new Uint8Array(128 * 128 * 4).fill(255);
      data[0] = i;
      const source = new THREE.DataTexture(data, 128, 128);
      source.needsUpdate = true;
      return source;
    });
    const atlas = new TextureAtlas({ tileSize: 128 });
    sources.forEach(source => atlas.add(source));

    const start = performance.now();
    atlas.update(renderer);
    const submitted = performance.now() - start;
    await finish();
    const cold = { submit: submitted, complete: performance.now() - start };

    const measure = async (prepare, iterations = 30) => {
      const submit = [], complete = [];
      for (let i = 0; i < iterations + 5; i++) {
        prepare();
        const begin = performance.now();
        atlas.update(renderer);
        const cpu = performance.now() - begin;
        await finish();
        if (i >= 5) {
          submit.push(cpu);
          complete.push(performance.now() - begin);
        }
      }
      return { submit: stats(submit), complete: stats(complete) };
    };

    const oneDirty = await measure(() => atlas.invalidate(sources[0]));
    const allDirty = await measure(() => atlas.invalidate());

    // Batch tiny operations so browser clock resolution does not hide steady-state cost.
    const idle = [], alias = [];
    for (let pass = 0; pass < 30; pass++) {
      let begin = performance.now();
      for (let i = 0; i < 1000; i++) atlas.update(renderer);
      idle.push((performance.now() - begin) / 1000);
      begin = performance.now();
      for (let i = 0; i < 1000; i++) atlas.add(sources[i % count]);
      alias.push((performance.now() - begin) / 1000);
    }

    const addition = new THREE.DataTexture(new Uint8Array(128 * 128 * 4).fill(255), 128, 128);
    addition.needsUpdate = true;
    sources.push(addition);
    atlas.add(addition);
    const begin = performance.now();
    atlas.update(renderer);
    const addSubmit = performance.now() - begin;
    await finish();
    const addToFreeCell = { submit: addSubmit, complete: performance.now() - begin };

    results.push({ count, cold, oneDirty, allDirty, addToFreeCell, idle: stats(idle), alias: stats(alias) });
    atlas.dispose();
    sources.forEach(source => source.dispose());
  }

  const adapter = backend === 'webgpu' ? (await navigator.gpu.requestAdapter()).info : null;
  const gl = backend === 'webgl' ? renderer.getContext() : null;
  const debug = gl?.getExtension('WEBGL_debug_renderer_info');
  const device = adapter ? { vendor: adapter.vendor, architecture: adapter.architecture, device: adapter.device }
    : gl?.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
  renderer.dispose();

  return { backend, device, isolated: crossOriginIsolated, userAgent: navigator.userAgent, tileSize: 128, results };
};
