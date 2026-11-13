import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { FluidCollider, ParticleSystem, GasSimulation } from '@rzmps/rzmps';
import { Fn, instanceIndex, uniform } from 'three/tsl';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
const renderer = new WebGPURenderer();
await renderer.init();
const scene = new THREE.Scene();
const system = new ParticleSystem(); scene.add(system);
const camera = new THREE.PerspectiveCamera();
await renderer.renderAsync(scene, camera);
window.bake = async (shape, path) => {
  const geometry = shape === 'box' ? new THREE.BoxGeometry()
    : shape === 'sphere' ? new THREE.SphereGeometry(0.5, 12, 8)
      : shape === 'plane' ? new THREE.PlaneGeometry() : (await new OBJLoader().loadAsync(path)).children[0].geometry;
  const surfaceThickness = shape === 'plane' ? 0.05 : shape === 'teapot' ? 0.02 : 0;
  const collider = new FluidCollider({ geometry, surfaceThickness,
    bakedFieldResolution: 16 });
  scene.add(collider); collider.syncGPUTransform(system);
  const start = performance.now();
  collider.prepareGPUField(renderer);
  const submission = performance.now() - start;
  const field = collider.gpuField;
  const data = new Float32Array(await renderer.getArrayBufferAsync(field.attribute));
  const completion = performance.now() - start;
  const other = new FluidCollider({ geometry, surfaceThickness: collider.surfaceThickness, bakedFieldResolution: 16 });
  other.prepareGPUField(renderer);
  const shared = other.gpuField === field;
  const values = [...new Set(data)];
  collider.position.x = 3; collider.syncGPUTransform(system); collider.prepareGPUField(renderer);
  const rigidReuse = collider.gpuField === field;
  const center = data[8 + 16 * (8 + 16 * 8)];
  // Recreate GPU resources from the compact geometry cache, then invalidate on vertex edits.
  geometry.dispose();
  const recreated = new FluidCollider({ geometry, surfaceThickness: collider.surfaceThickness,
    bakedFieldResolution: 16 });
  recreated.prepareGPUField(renderer);
  const cachedUpload = recreated.gpuField.cacheHit;
  await renderer.getArrayBufferAsync(recreated.gpuField.attribute);
  const oldField = recreated.gpuField;
  geometry.getAttribute('position').needsUpdate = true;
  recreated.prepareGPUField(renderer);
  const invalidated = recreated.gpuField !== oldField;
  await renderer.getArrayBufferAsync(recreated.gpuField.attribute);
  return { shape, submission, completion, shared, rigidReuse, cachedUpload, invalidated, center, values,
    occupied: data.reduce((sum, value) => sum + value, 0), metrics: field.metrics };
};
window.ready = true;

window.sharedFluidSystems = async () => {
  const geometry = new THREE.BoxGeometry();
  const fields = [], timings = [];
  for (let i = 0; i < 2; i++) {
    const collider = new FluidCollider({ geometry, bakedFieldResolution: 16 });
    const gas = new GasSimulation({ spatialEffects: [collider], initialBrickCapacity: 8, maxActiveBricks: 8,
      bounds: new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)),
      boundsPadding: 0, automaticPadding: false, spatialGridOptions: { brickSubdivisions: 1, cellSubdivisions: 2 } });
    const owner = new ParticleSystem({ gpuProcessing: true, emitters: [], modules: [gas], renderers: [] });
    const compile = renderer.compileComputeAsync;
    const compilation = [];
    renderer.compileComputeAsync = async function (nodes) {
      const start = performance.now();
      const result = await compile.call(this, nodes);
      compilation.push(performance.now() - start);
      return result;
    };
    const start = performance.now();
    try { await owner.prepare(renderer); } finally { renderer.compileComputeAsync = compile; }
    const preparationMs = performance.now() - start;
    fields.push(collider.gpuField);
    const grid = gas.volumeGrid;
    renderer.compute(Fn(() => {
      grid.pages.element(instanceIndex).assign(instanceIndex.add(1));
      grid.slots.element(instanceIndex).assign(instanceIndex.add(1));
    })().compute(grid.brickCount));
    grid.updateDispatch(renderer);
    await renderer.backend.device.queue.onSubmittedWorkDone();
    const boundaryStart = performance.now();
    gas.computeSolidField({ system: owner, deltaTimeNode: uniform(1 / 60) }, renderer);
    const firstBoundarySubmissionMs = performance.now() - boundaryStart;
    await renderer.backend.device.queue.onSubmittedWorkDone();
    timings.push({ preparationMs, firstBoundarySubmissionMs,
      firstBoundaryFencedMs: performance.now() - boundaryStart,
      boundaryPipelineCompilationMs: compilation[0],
      bake: { ...collider.gpuField.metrics } });
    owner.destroy();
  }
  const shared = fields[0] === fields[1];
  geometry.dispose();
  return { shared, timings };
};
