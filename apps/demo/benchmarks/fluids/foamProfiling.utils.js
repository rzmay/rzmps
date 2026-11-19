import { Fn, If, float, instanceIndex, storage, vec4 } from 'three/tsl';
import { StorageBufferAttribute } from 'three/webgpu';
import { SurfaceAttachment, BenchmarkMetricType, BenchmarkDomain } from '@rzmps/rzmps';
import { readLiquidMarkers } from './liquidQuality.utils.js';
import { median } from './fluidProfiling.utils.js';

/** Explicit checkpoint microbenchmarks. Production attachment stays fused with ordinary particle integration.
 * Query/full-attachment kernels read the same frozen foam state and write scratch, never authoritative markers.
 * Full attachment includes its query; these GPU measurements must not be added together. */
export async function benchmarkFoam(system, renderer, scene, camera, timer, state) {
  const foam = [...system.subSystems.keys()].find(child => child.getModules(SurfaceAttachment).length);
  if (!foam) return null;
  const markers = await readLiquidMarkers(foam, renderer), buffers = foam.gpuSimulation._gpuBuffers;
  if (!markers.length || !buffers) return { particleCount: markers.length, status: 'no live foam at checkpoint' };
  const attachment = foam.getModules(SurfaceAttachment)[0];
  const output = new StorageBufferAttribute(new Float32Array(buffers.count * 8), 4);
  const result = storage(output, 'vec4', buffers.count * 2);
  const query = Fn(() => {
    const particle = buffers.storage.createParticle(undefined, true);
    If(particle.alive.notEqual(0), () => {
      const sample = attachment.sampleSurfaceGPU(attachment.toWorld.mul(vec4(particle.position, 1)).xyz);
      result.element(instanceIndex.mul(2)).assign(vec4(sample.normal, sample.distance));
      result.element(instanceIndex.mul(2).add(1)).assign(vec4(sample.velocity, sample.valid));
    });
  })().compute(buffers.count);
  const constrain = Fn(() => {
    const particle = buffers.storage.createParticle(undefined, true);
    If(particle.alive.notEqual(0), () => {
      attachment.finalizeGPU(particle, float(1 / 60));
      result.element(instanceIndex.mul(2)).assign(vec4(particle.position, particle.alive));
      result.element(instanceIndex.mul(2).add(1)).assign(vec4(particle.velocity, particle.speed));
    });
  })().compute(buffers.count);
  const measure = async (label, operation) => {
    const previous = state.stage;
    state.stage = label;
    const cpuStart = performance.now();
    timer?.start();
    try {
      await operation();
      const cpuSubmissionMs = performance.now() - cpuStart;
      const gpu = timer ? await timer.finish() : null;
      return { cpuSubmissionMs, gpuMs: gpu?.totalGPUms ?? null };
    } finally { state.stage = previous; }
  };
  const visible = new Map(), mesh = foam.renderers[0].webgpuMesh;
  try {
    await renderer.compileComputeAsync([query, constrain]);
    const querySamples = [], attachmentSamples = [];
    for (let i = 0; i < 3; i++) {
      querySamples.push(await measure('foam/surface-query', () => renderer.compute(query)));
      attachmentSamples.push(await measure('foam/attachment', () => renderer.compute(constrain)));
    }
    scene.traverse(object => {
      if (object.isMesh || object.isPoints || object.isLine || object.isSprite) {
        visible.set(object, object.visible); object.visible = object === mesh;
      }
    });
    state.renderStage = 'foam/rendering';
    const rendering = await measure('foam/rendering', () => renderer.renderAsync(scene, camera));
    // Same frozen liquid, camera and lights: isolate the marginal material/children draw cost too.
    for (const [object, value] of visible) object.visible = value;
    const fullScene = [], withoutFoam = [];
    for (let i = 0; i < 3; i++) {
      state.renderStage = 'scene/with-foam';
      fullScene.push(await measure(state.renderStage, () => renderer.renderAsync(scene, camera)));
      if (mesh) mesh.visible = false;
      state.renderStage = 'scene/without-foam';
      withoutFoam.push(await measure(state.renderStage, () => renderer.renderAsync(scene, camera)));
      if (mesh) mesh.visible = visible.get(mesh) ?? true;
    }
    // Read the frozen arena counters explicitly; the ordinary UI observation can lag by 250 ms.
    const childCounters = foam.renderers[0]._gpuChildren?.counters;
    const childCounts = childCounters
      ? new Uint32Array(await renderer.getArrayBufferAsync(childCounters)) : new Uint32Array(3);
    const metrics = { particleCount: markers.length, dispatchedSlots: buffers.count,
      renderedChildren: Math.max(0, childCounts[0] + childCounts[1] - childCounts[2]),
      childOverflow: childCounts[2],
      observedRenderedChildren: foam.renderers.reduce((count, view) => count + view.renderedChildCount, 0),
      surfaceQueryGPUms: median(querySamples.map(sample => sample.gpuMs)),
      surfaceAttachmentGPUms: median(attachmentSamples.map(sample => sample.gpuMs)),
      foamRenderingGPUms: rendering.gpuMs,
      sceneWithFoamGPUms: median(fullScene.map(sample => sample.gpuMs)),
      sceneWithoutFoamGPUms: median(withoutFoam.map(sample => sample.gpuMs)),
      scope: 'Frozen-state scratch kernels; attachment includes query. Foam-only scene rendering includes depth/clear.',
      queryCPUms: median(querySamples.map(sample => sample.cpuSubmissionMs)),
      attachmentCPUms: median(attachmentSamples.map(sample => sample.cpuSubmissionMs)),
    };
    for (const name of ['surfaceQueryGPUms', 'surfaceAttachmentGPUms', 'foamRenderingGPUms']) {
      attachment.benchmarks.register(name, { type: BenchmarkMetricType.Gauge, unit: 'ms', domain: BenchmarkDomain.GPU,
        source: 'Explicit frozen-state checkpoint benchmark, not an ordinary timestep span' });
      attachment.benchmarks.set(name, metrics[name]);
    }
    attachment.benchmarks.set('foamParticleCount', metrics.particleCount);
    return metrics;
  } finally {
    state.renderStage = undefined;
    for (const [object, value] of visible) object.visible = value;
    await renderer.backend.device.queue.onSubmittedWorkDone();
    query.dispose(); constrain.dispose(); renderer.backend.destroyAttribute(output); output.dispose();
  }
}
