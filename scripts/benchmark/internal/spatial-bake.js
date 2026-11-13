/* eslint-env browser */
import * as THREE from 'three';
import { WebGPURenderer, StorageBufferAttribute } from 'three/webgpu';
import { Fn, float, instanceIndex, storage, uniform, vec3 } from 'three/tsl';
import { ParticleSystem, SpatialEffect, SpatialEffectUpdatePolicy } from '@rzmps/rzmps';

const renderer = new WebGPURenderer();
renderer.setSize(128, 128);
document.body.append(renderer.domElement);
await renderer.init();
const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
const system = new ParticleSystem({ gpuProcessing: true, emitters: [], modules: [], renderers: [] });
scene.add(system);
await renderer.renderAsync(scene, camera);

window.benchmarkSpatialBake = async () => {
  const geometry = new THREE.TorusKnotGeometry(0.7, 0.2, 32, 6);
  const effect = new SpatialEffect(null, { geometry, feather: 0.25, bakedFieldResolution: 16,
    updatePolicy: SpatialEffectUpdatePolicy.TransformDynamic,
    modifyGPU: particle => particle.alpha.mulAssign(0.5) });
  const attribute = new StorageBufferAttribute(new Float32Array(64), 1);
  const output = storage(attribute, 'float', 64);
  const context = { system, deltaTimeNode: uniform(1 / 60), elapsedTimeNode: uniform(0),
    simulationToWorldNode: uniform(new THREE.Matrix4()), worldToSimulationNode: uniform(new THREE.Matrix4()) };
  const fence = () => renderer.backend.device.queue.onSubmittedWorkDone();
  const timeCPU = callback => { const start = performance.now(); callback(); return performance.now() - start; };
  try {
    const coldBakeCpuMs = timeCPU(() => effect.syncGPUTransform(system));
    const cachedBakeCpuMs = timeCPU(() => effect.syncGPUTransform(system));
    effect.position.x += 0.1;
    const transformCpuMs = timeCPU(() => effect.syncGPUTransform(system));
    const texture = effect._bakedFieldTexture;
    if (!texture) throw new Error('Expected custom-geometry inclusion bake');
    const uploadStart = performance.now();
    renderer.initTexture(texture);
    const uploadSubmitMs = performance.now() - uploadStart;
    await fence();
    const uploadFencedMs = performance.now() - uploadStart;
    const node = Fn(() => {
      const x = float(instanceIndex.mod(4)).sub(1.5).mul(0.5);
      const y = float(instanceIndex.div(4).mod(4)).sub(1.5).mul(0.5);
      const z = float(instanceIndex.div(16)).sub(1.5).mul(0.5);
      output.element(instanceIndex).assign(effect.sampleDeltasGPU(vec3(x, y, z), {},
        context.deltaTimeNode, context).alpha);
    })().compute(64);
    const compileStart = performance.now();
    await renderer.compileComputeAsync([node]);
    const compileMs = performance.now() - compileStart;
    const dispatchStart = performance.now();
    renderer.compute(node);
    const firstDispatchSubmitMs = performance.now() - dispatchStart;
    await fence();
    const firstDispatchFencedMs = performance.now() - dispatchStart;
    const data = new Float32Array(await renderer.getArrayBufferAsync(attribute));
    if (!data.every(Number.isFinite)) throw new Error('Non-finite spatial effect samples');
    node.dispose();
    return { bakeBackend: 'CPU', samplingBackend: 'WebGPU', resolution: 16,
      triangles: geometry.index.count / 3, coldBakeCpuMs, cachedBakeCpuMs,
      transformCpuMs, uploadSubmitMs, uploadFencedMs, compileMs, firstDispatchSubmitMs, firstDispatchFencedMs };
  } finally {
    attribute.dispose();
    effect._bakedFieldTexture?.dispose();
    geometry.dispose();
  }
};
window.ready = true;
