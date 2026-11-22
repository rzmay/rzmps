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

// Exercise more geometry fields than the baseline device's sampled-texture limit permits individually.
window.manyFluidColliders = async (sharedGeometry = false) => {
  const { StorageBufferAttribute } = await import('three/webgpu');
  const { storage, vec3, uint } = await import('three/tsl');
  const shared = sharedGeometry ? new THREE.BoxGeometry(0.35, 0.35, 0.35) : undefined;
  const colliders = Array.from({ length: 20 }, (_, i) => {
    const collider = new FluidCollider({ geometry: shared ?? new THREE.BoxGeometry(0.35, 0.35, 0.35),
      bakedFieldResolution: sharedGeometry ? 8 : i % 2 ? 8 : 12 });
    collider.position.set((i % 4 - 1.5) * 0.45, (Math.floor(i / 4) % 3 - 1) * 0.45,
      Math.floor(i / 12) * 0.45);
    return collider;
  });
  const gas = new GasSimulation({ spatialEffects: colliders, initialBrickCapacity: 8, maxActiveBricks: 8,
    bounds: new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)),
    automaticPadding: false, spatialGridOptions: { brickSubdivisions: 1, cellSubdivisions: 2 } });
  const owner = new ParticleSystem({ gpuProcessing: true, emitters: [], modules: [gas], renderers: [] });
  const nodes = [], buffers = [];
  try {
    await owner.prepare(renderer);
    const grid = gas.volumeGrid;
    renderer.compute(Fn(() => {
      grid.pages.element(instanceIndex).assign(instanceIndex.add(1));
      grid.slots.element(instanceIndex).assign(instanceIndex.add(1));
    })().compute(grid.brickCount));
    grid.updateDispatch(renderer);
    const context = { system: owner, deltaTimeNode: uniform(1 / 60) };
    gas.computeSolidField(context, renderer);
    const fields = colliders.map(collider => collider.getGPUField());
    const points = [-0.5, -0.175, -0.12, 0, 0.12, 0.175, 0.5];
    const referenceAttribute = new StorageBufferAttribute(new Float32Array(points.length * colliders.length), 1);
    const sampledAttribute = new StorageBufferAttribute(new Float32Array(points.length * colliders.length), 1);
    buffers.push(referenceAttribute, sampledAttribute);
    const reference = storage(referenceAttribute, 'float', points.length * colliders.length);
    const sampled = storage(sampledAttribute, 'float', points.length * colliders.length);
    for (let i = 0; i < colliders.length; i++) {
      const node = Fn(() => {
        points.forEach((x, j) => reference.element(i * points.length + j).assign(
          fields[i].sample(vec3(x, 0, 0), false)));
      })().compute(1);
      nodes.push(node); renderer.compute(node);
    }
    const atlasNode = Fn(() => {
      colliders.forEach((collider, i) => {
        const sampler = gas.colliderAtlas.sampler(fields[i]);
        points.forEach((x, j) => sampled.element(uint(i * points.length + j)).assign(
          fields[i].sample(vec3(x, 0, 0), false, sampler)));
      });
    })().compute(1);
    nodes.push(atlasNode); renderer.compute(atlasNode);
    const expected = new Float32Array(await renderer.getArrayBufferAsync(referenceAttribute));
    const actual = new Float32Array(await renderer.getArrayBufferAsync(sampledAttribute));
    const solids = new Float32Array(await renderer.getArrayBufferAsync(gas.solidAttribute));
    const boundary = new Float32Array(await renderer.getArrayBufferAsync(gas.boundaryAttribute));
    const createQuery = gas.colliderAtlas.createQuery;
    let boundaryError = 0, solidError = 0;
    try {
      gas.colliderAtlas.createQuery = () => undefined;
      gas.solidNode = gas.solidFreshNode = undefined;
      gas.solidStateKey = '';
      gas.computeSolidField(context, renderer);
      const referenceSolid = new Float32Array(await renderer.getArrayBufferAsync(gas.solidAttribute));
      const referenceBoundary = new Float32Array(await renderer.getArrayBufferAsync(gas.boundaryAttribute));
      for (let i = 0; i < solids.length; i++) {
        solidError = Math.max(solidError, Math.abs(referenceSolid[i] - solids[i]));
      }
      for (let i = 0; i < boundary.length; i++) {
        boundaryError = Math.max(boundaryError, Math.abs(referenceBoundary[i] - boundary[i]));
      }
    } finally {
      gas.colliderAtlas.createQuery = createQuery;
      gas.solidNode = gas.solidFreshNode = undefined;
    }
    const compact = !!gas.colliderAtlas.queryAttribute;
    const firstAtlas = gas.colliderAtlas.texture;
    gas.computeSolidField(context, renderer);
    const reused = firstAtlas === gas.colliderAtlas.texture;
    gas.spatialEffects = colliders.slice(0, 2);
    gas.computeSolidField(context, renderer);
    const released = !gas.colliderAtlas.texture;
    return { fields: fields.length, limit: renderer.backend.device.limits.maxSampledTexturesPerShaderStage,
      error: Math.max(...actual.map((value, i) => Math.abs(value - expected[i]))),
      occupied: solids.reduce((sum, value) => sum + value, 0),
      finite: boundary.every(Number.isFinite), reused, released, boundaryError, solidError, compact,
      uniqueFields: new Set(fields).size };
  } finally {
    await renderer.backend.device.queue.onSubmittedWorkDone();
    nodes.forEach(node => node.dispose()); buffers.forEach(buffer => buffer.dispose());
    owner.destroy(); new Set(colliders.map(collider => collider.geometry)).forEach(geometry => geometry.dispose());
  }
};
