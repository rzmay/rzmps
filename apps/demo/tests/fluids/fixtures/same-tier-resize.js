import * as THREE from 'three';
import { WebGPURenderer, StorageBufferAttribute } from 'three/webgpu';
import { bindStorageAttributeLifetime } from '../../../../../packages/rzmps/src/utils/gpu/storage.utils.ts';
import { Fn, float, instanceIndex, vec3, vec4, storage } from 'three/tsl';
import { ParticleSystem, GasSimulation, FLIPSimulation, VolumeRenderer } from '@rzmps/rzmps';

const renderer = new WebGPURenderer({ trackTimestamp: true });
renderer.setSize(128, 128);
await renderer.init();
const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 50);
camera.position.set(0, 0, 6);
const box = () => new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
const fields = ['velocityCurrentAttribute', 'velocityNextAttribute', 'pressureCurrentAttribute',
  'divergenceAttribute', 'solidAttribute', 'boundaryAttribute'];
const read = async attribute => new Float32Array(await renderer.getArrayBufferAsync(attribute));

window.measureFlipSampling = async () => {
  const { simulation: fluid, system } = await create('liquid');
  const projection = fluid.getPressureProjection(), grid = fluid.workGrid;
  const points = [[1.2, 1.7, 1.3], [3.9, 4.1, 3.8], [6.6, 6.5, 6.7]];
  const output = new StorageBufferAttribute(new Float32Array(points.length * 8), 4);
  const values = storage(output, 'vec4', points.length * 2);
  const coefficients = [[0.1, 0.2, 0.3], [0.2, 0.3, 0.4], [0.3, 0.4, 0.5]];
  const offset = [1, 2, -1], results = [], nodes = [];
  try {
    for (const linear of [false, true]) for (const halfDry of [false, true]) {
      const seed = projection.compute(index => {
        const c = projection.coordinate(index, fluid.resolution + 1);
        const velocity = coefficients.map((row, axis) => {
          const location = vec3(c).add(vec3(axis === 0 ? 0 : 0.5,
            axis === 1 ? 0 : 0.5, axis === 2 ? 0 : 0.5));
          return linear ? location.dot(vec3(...row)).add(offset[axis]) : float(offset[axis]);
        });
        projection.faces.element(index).assign(vec4(...velocity, 0));
        projection.beforeFaces.element(index).assign(vec4(...velocity, 0).mul(0.25));
      }, true);
      const wet = grid.compute(index => {
        const x = grid.coordinate(index).x;
        fluid.velocityNext.element(index).w.assign(halfDry ? x.lessThan(4).select(2, 0) : 2);
      });
      const sample = Fn(() => {
        points.forEach((point, i) => {
          values.element(i * 2).assign(vec4(projection.sample(vec3(...point)), 0));
          values.element(i * 2 + 1).assign(vec4(projection.sample(vec3(...point), true), 0));
        });
      })().compute(1);
      nodes.push(seed, wet, sample);
      renderer.compute([seed, wet, sample]);
      results.push({ linear, halfDry, points, values: [...await read(output)] });
    }
    const controls = projection.controls;
    projection.controls = () => ({ ...controls(), minIterations: 24, maxIterations: 24,
      warmStart: false, multigrid: true, diagnostics: false });
    renderer.backend.device.pushErrorScope('validation');
    projection.solve(renderer, fluid.velocityNext, fluid.velocityCurrent, 24);
    await renderer.backend.device.queue.onSubmittedWorkDone();
    const validation = await renderer.backend.device.popErrorScope();
    const multigrid = validation ? undefined : await projection.readDiagnostics(renderer, fluid.velocityCurrent);
    projection.controls = controls;
    return { results, dimensions: grid.gridDimensions.toArray(), multigrid, validation: validation?.message ?? null };
  } finally {
    await renderer.backend.device.queue.onSubmittedWorkDone();
    nodes.forEach(node => node.dispose());
    output.dispose(); system.destroy();
  }
};

async function create(kind, capacityCase = false) {
  const simulation = new (kind === 'gas' ? GasSimulation : FLIPSimulation)({ bounds: box(),
    spatialGridOptions: { brickSubdivisions: capacityCase ? 3 : 1, cellSubdivisions: capacityCase ? 4 : 2,
      minVolumeQuality: 2, maxVolumeQuality: 2 },
    initialBrickCapacity: 8, maxActiveBricks: 8, pressureIterations: 4,
    adaptiveTimestep: false, externalForce: new THREE.Vector3(), sourceStrength: 0,
    buoyancy: 0, weight: 0, densityDissipation: 0, velocityDissipation: 0, particleSeparation: 0 });
  if (capacityCase) {
    simulation.workGrid.dispose(); simulation.workGrid = undefined;
    simulation.velocityBeforeAttribute = undefined; simulation.velocityBefore = undefined;
    simulation.createWorkGrid(128);
  }
  const volume = kind === 'gas' ? new VolumeRenderer({ steps: 24, dynamicResolution: false }) : undefined;
  const system = new ParticleSystem({ gpuProcessing: true, maxParticles: 1, emitters: [],
    modules: [simulation], renderers: volume ? [volume] : [] });
  const scene = new THREE.Scene(); scene.add(system);
  await renderer.renderAsync(scene, camera);
  await system.prepare(renderer);
  for (let i = 0; i < 4; i++) {
    system.advanceFrames(1, 1 / 60);
    await renderer.renderAsync(scene, camera);
    await renderer.resolveTimestampsAsync('compute'); await renderer.resolveTimestampsAsync('render');
  }
  const grid = simulation.volumeGrid ?? simulation.workGrid;
  const activate = () => {
    renderer.compute(Fn(() => {
      grid.pages.element(instanceIndex).assign(instanceIndex.add(1));
      grid.slots.element(instanceIndex).assign(instanceIndex.add(1));
    })().compute(Math.min(grid.capacity, grid.brickCount)));
    grid.updateDispatch(renderer);
    renderer.compute(simulation.computeCells(index => {
      simulation.velocityCurrent.element(index).assign(vec4(1, 2, 3, 2));
      simulation.velocityNext.element(index).assign(vec4(4, 5, 6, 2));
      simulation.pressureCurrent.element(index).assign(0.75);
      simulation.divergence.element(index).assign(0.1);
      simulation.solid.element(index).assign(0);
      simulation.faceOpenness.element(index).assign(vec4(1));
    }));
    if (simulation.densityCurrent) {
      renderer.compute(simulation.computeCells(index => {
        simulation.densityCurrent.element(index).assign(vec4(1, 2, 0, 0));
        simulation.colorCurrent.element(index).assign(vec4(0.2, 0.4, 0.8, 0));
        simulation.visualDensity.element(index).assign(vec4(0.5, 0.25, 0, 0));
        simulation.visualColor.element(index).assign(vec4(0.1, 0.2, 0.3, 0));
      }));
    }
  };
  activate();
  return { simulation, system, scene, volume, activate };
}

window.measureResize = async (kind = 'gas', change = 'grow') => {
  const { simulation: fluid, system, scene, volume } = await create(kind);
  const grid = fluid.spatialGrid;
  const backing = fluid.volumeGrid ?? fluid.workGrid;
  const attributes = fields.map(key => fluid[key]);
  if (kind === 'gas') attributes.push(fluid.densityCurrent.value, fluid.colorCurrent.value, fluid.visualAttribute);
  attributes.push(fluid.getPressureProjection().attribute);
  const beforeValues = await Promise.all(attributes.map(read));
  const before = { backing, pages: backing.pagesAttribute, pressure: fluid.getPressureProjection(),
    velocityNodes: fluid.velocityNodes, outputs: fluid.outputNodes, gather: fluid.gatherNode,
    pressureNodes: [...fluid.getPressureProjection().pressureNodes], texture: fluid.densityTexture,
    capacity: backing.capacity, material: volume?.mesh?.material,
    modifierVersion: fluid.version, particleVersion: system.gpuSimulation._gpuBuffers.version,
    indexVersion: grid.resourceVersion, transfer: fluid.transferNode };
  const target = fluid.bounds.clone(), brick = backing.brickSize;
  if (change === 'translate') target.translate(new THREE.Vector3(0, brick, 0));
  else if (change === 'jump') target.max.y += brick * 2;
  else if (change === 'shrink') target.max.y -= brick;
  else target.max.y += brick;
  let pipelines = 0, graphResets = 0, phase = 'layout';
  const compiled = [];
  const pipeline = renderer.backend.createComputePipeline;
  renderer.backend.createComputePipeline = function (...args) {
    pipelines++;
    compiled.push({ name: args[0].computeProgram?.name, code: args[0].computeProgram?.code?.slice(-1600) });
    const start = performance.now();
    try { return pipeline.apply(this, args); }
    finally {
      const elapsed = performance.now() - start;
      spans.pipelineSubmissionMs += elapsed;
      if (phase.startsWith('pressure')) spans.pressurePipelineCompilationMs += elapsed;
    }
  };
  const reset = fluid.resetGasNodes;
  if (reset) fluid.resetGasNodes = function (...args) { graphResets++; return reset.apply(this, args); };
  const spans = { layoutCalculationMs: 0, directoryUpdateAllocationMs: 0, fieldAllocationMs: 0,
    pressureResourcePreparationMs: 0, pressureGraphConstructionMs: 0, pressurePipelineCompilationMs: 0,
    transportGraphConstructionMs: 0, exportGraphConstructionMs: 0, migrationSubmissionMs: 0,
    migrationFenceMs: 0, totalSubmissionMs: 0, totalFencedMs: 0, pipelineSubmissionMs: 0 };
  const wrappers = [];
  const instrument = (owner, key, span, enabled = () => true) => {
    const original = owner?.[key];
    if (!original) return;
    owner[key] = function (...args) {
      const measured = enabled(), start = performance.now(), previousPhase = phase;
      if (measured) phase = span;
      try { return original.apply(this, args); }
      finally {
        if (measured) spans[span] += performance.now() - start;
        phase = previousPhase;
      }
    };
    wrappers.push(() => { owner[key] = original; });
  };
  instrument(backing, 'updateLayout', 'directoryUpdateAllocationMs');
  instrument(Object.getPrototypeOf(backing), 'reindexFrom', 'directoryUpdateAllocationMs');
  instrument(fluid, 'allocateGasFields', 'fieldAllocationMs');
  instrument(fluid, 'resizeGridFields', 'fieldAllocationMs');
  instrument(fluid, 'getPressureProjection', 'pressureResourcePreparationMs', () => !fluid.pressureProjection);
  instrument(fluid, 'solveProjection', 'pressureGraphConstructionMs',
    () => !fluid.pressureProjection?.pressureNodes.length);
  instrument(fluid, 'computeTransport', 'transportGraphConstructionMs', () => !fluid.gpuCacheKey);
  instrument(fluid, 'renderGPU', 'exportGraphConstructionMs', () => !fluid.visualCacheKey);
  instrument(fluid, 'remapFields', 'migrationSubmissionMs');
  const start = performance.now();
  grid.setBounds(target);
  const layoutCalculationMs = performance.now() - start;
  const previous = fluid.bounds.clone();
  fluid.bounds.copy(grid.bounds); fluid.boundsMinNode.value.copy(grid.bounds.min);
  fluid.onBoundsChanged(previous);
  const updateStart = performance.now();
  fluid.ensureGridResolution(renderer, grid);
  if (kind === 'gas') fluid.updateExportLayout(renderer);
  const resizeSubmissionMs = performance.now() - updateStart;
  const resizeGPUms = await renderer.resolveTimestampsAsync('compute');
  await renderer.backend.device.queue.onSubmittedWorkDone();
  const resizeFencedMs = performance.now() - updateStart;
  const baseline = new URLSearchParams(location.search).has('baseline');
  const afterValues = baseline ? beforeValues : await Promise.all(attributes.map(read));
  const sameFields = attributes.every((attribute, i) => attribute === fluid[fields[i]] || i >= fields.length);
  // Translation preserves retained resident slots; removal only changes their directory visibility.
  const live = new Uint32Array(await renderer.getArrayBufferAsync((fluid.volumeGrid ?? fluid.workGrid).pagesAttribute));
  const current = fluid.volumeGrid ?? fluid.workGrid;
  const slots = live.subarray(current.directoryCapacity ?? current.brickCount,
    (current.directoryCapacity ?? current.brickCount) + current.capacity);
  let exact = true, retained = 0;
  slots.forEach((encoded, slot) => {
    if (!encoded) return;
    retained++;
    const count = current.cellsPerBrick;
    beforeValues.forEach((values, index) => {
      const channels = attributes[index].itemSize;
      const stride = index === attributes.length - 1 ? (current.brickSide + 1) ** 3 : count;
      const plane = index === attributes.length - 1
        ? (current.capacity * stride + 1) * channels : current.cellCount * channels;
      for (let offset = 0; offset < values.length; offset += plane) {
        for (let i = offset + slot * stride * channels; i < offset + (slot + 1) * stride * channels; i++) {
          exact &&= values[i] === afterValues[index][i];
        }
      }
    });
  });
  const layoutPipelines = pipelines;
  spans.layoutCalculationMs = layoutCalculationMs;
  spans.migrationFenceMs = resizeFencedMs - resizeSubmissionMs;
  spans.totalSubmissionMs = layoutCalculationMs + resizeSubmissionMs;
  spans.totalFencedMs = layoutCalculationMs + resizeFencedMs;
  const stepStart = performance.now();
  system.advanceFrames(1, 1 / 60);
  await renderer.renderAsync(scene, camera);
  await renderer.resolveTimestampsAsync('compute'); await renderer.resolveTimestampsAsync('render');
  await renderer.backend.device.queue.onSubmittedWorkDone();
  const followupFencedMs = performance.now() - stepStart;
  const result = { kind, change, layoutCalculationMs, resizeSubmissionMs, resizeFencedMs, resizeGPUms,
    spans, followupFencedMs, pipelines, layoutPipelines, compiled, graphResets, exact, retained, sameFields,
    sameDirectory: before.pages === current.pagesAttribute, sameGrid: before.backing === current,
    samePressure: before.pressure === fluid.getPressureProjection(),
    sameTexture: before.texture === fluid.densityTexture,
    sameTransport: before.velocityNodes === fluid.velocityNodes && before.outputs === fluid.outputNodes,
    modifierVersions: [before.modifierVersion, fluid.version],
    particleVersions: [before.particleVersion, system.gpuSimulation._gpuBuffers.version],
    indexVersions: [before.indexVersion, grid.resourceVersion], sameTransfer: before.transfer === fluid.transferNode,
    samePressureGraphs: before.pressureNodes.every((node, i) => (
      node === fluid.getPressureProjection().pressureNodes[i]
    )),
    capacityChanged: before.capacity !== current.capacity, cellSize: fluid.cellSize,
    dimensions: fluid.gridDimensions.toArray() };
  renderer.backend.createComputePipeline = pipeline;
  if (reset) fluid.resetGasNodes = reset;
  wrappers.forEach(restore => restore());
  system.destroy();
  return result;
};
// Directory and export backing growth may yield; resident fields and compiled graph identities survive.
window.measureBackingGrowth = async () => {
  const { simulation: gas, system, scene } = await create('gas');
  const backing = gas.volumeGrid, oldDirectory = backing.pagesAttribute;
  const originalCapacity = backing.directoryCapacity, fields = gas.velocityCurrentAttribute;
  const pressure = gas.getPressureProjection(), output = gas.outputNodes;
  const dimensions = backing.gridDimensions.clone();
  dimensions.y = (originalCapacity / 4 + 2) * backing.brickSide;
  const target = backing.bounds.clone();
  target.max.y = target.min.y + dimensions.y * backing.cellSize;
  const start = performance.now();
  let ready = backing.updateLayout(renderer, target, dimensions);
  const staged = !ready && oldDirectory === backing.pagesAttribute;
  // A newer compatible request is absorbed by the pending capacity operation.
  dimensions.y += backing.brickSide;
  target.max.y += backing.brickSize;
  for (let i = 0; !ready && i < 200; i++) {
    await new Promise(resolve => setTimeout(resolve, 4));
    ready = backing.updateLayout(renderer, target, dimensions);
  }
  await renderer.backend.device.queue.onSubmittedWorkDone();
  const directoryFencedMs = performance.now() - start;
  const pages = new Uint32Array(await renderer.getArrayBufferAsync(backing.pagesAttribute));
  const retained = [...pages.slice(0, backing.brickCount)].filter(Boolean).length;
  const texture = gas.densityTexture;
  let textureReady = gas.ensureTextureCapacity(renderer, dimensions);
  const textureStaged = !textureReady && texture === gas.densityTexture;
  for (let i = 0; !textureReady && i < 200; i++) {
    await new Promise(resolve => setTimeout(resolve, 4));
    textureReady = gas.ensureTextureCapacity(renderer, dimensions);
  }
  // Export into the new backing with the original cached graph, then sample it through the renderer.
  gas.gridDimensions.copy(dimensions); gas.dimensionsNode.value.copy(dimensions);
  gas.bounds.copy(target); gas.density.bounds.copy(target); gas.colorField.bounds.copy(target);
  gas.density.resolution.copy(dimensions); gas.colorField.resolution.copy(dimensions);
  gas.updateExportLayout(renderer);
  gas.clearOutputTextures(renderer);
  renderer.compute(gas.outputNodes.get(gas.densityCurrent));
  gas.density.version++; gas.colorField.version++;
  await renderer.renderAsync(scene, camera);
  await renderer.backend.device.queue.onSubmittedWorkDone();
  const result = { ready, staged, retained, originalCapacity, capacity: backing.directoryCapacity,
    directoryFencedMs, textureReady, textureStaged, textureChanged: texture !== gas.densityTexture,
    sameResident: fields === gas.velocityCurrentAttribute, samePressure: pressure === gas.getPressureProjection(),
    sameExport: output === gas.outputNodes, dimensions: backing.gridDimensions.toArray() };
  system.destroy();
  return result;
};
window.measureFlipPoolGrowth = async () => {
  const { simulation: flip, system } = await create('flip');
  const pool = flip.workPool, oldGrid = flip.workGrid;
  const velocity = await read(flip.velocityCurrentAttribute);
  const oldCount = flip.cellCount;
  pool.request(pool.capacity);
  const target = flip.bounds.clone(); target.max.y += oldGrid.brickSize;
  flip.spatialGrid.setBounds(target); flip.bounds.copy(target);
  flip.boundsMinNode.value.copy(target.min);
  flip.ensureGridResolution(renderer, flip.spatialGrid);
  await pool.whenPrepared();
  const committed = pool.commit();
  const next = await read(flip.velocityCurrentAttribute);
  let exact = true;
  for (let plane = 0; plane < 2; plane++) {
    for (let i = 0; i < (oldCount - 1) * 4; i++) {
      exact &&= velocity[plane * oldCount * 4 + i] === next[plane * flip.cellCount * 4 + i];
    }
  }
  const result = { committed, exact, capacity: pool.capacity, previous: oldGrid.capacity,
    requests: pool.metrics.requests, dimensions: flip.workGrid.gridDimensions.toArray(), metrics: pool.metrics };
  system.destroy();
  return result;
};
// A pending derived texture must not block a compatible sparse-domain extension.
window.verifyImmediateCoverage = async () => {
  const { simulation: gas, system, scene } = await create('gas');
  const original = gas.bounds.clone(), grid = gas.spatialGrid, sparse = gas.volumeGrid;
  const fields = gas.velocityCurrentAttribute, texture = gas.densityTexture;
  gas.occupiedBounds.copy(original);
  const target = original.clone();
  target.max.y += 4 * sparse.brickSize;
  grid.setBounds(target);
  const allocation = gas.ensureTextureCapacity;
  gas.ensureTextureCapacity = () => false;
  gas.bounds.copy(grid.bounds);
  gas.boundsMinNode.value.copy(grid.bounds.min);
  gas.ensureGridResolution(renderer, grid);
  gas.updateExportLayout(renderer);
  const covered = gas.bounds.equals(grid.bounds) && sparse.bounds.equals(grid.bounds);
  const retainsSupport = gas.density.bounds.containsBox(original);
  const boundedExport = gas.density.resolution.toArray().every((n, axis) =>
    n <= gas.textureDimensions.getComponent(axis));
  gas.clearOutputTextures(renderer);
  renderer.compute(gas.outputNodes.get(gas.densityCurrent));
  const centers = [new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5)];
  const observed = await gas.readBrickDiagnostics(renderer, centers);
  gas.showGridHelper = true;
  sparse.updateVisualization(renderer, gas.densityCurrent, gas.densityCutoffNode);
  gas.updateBoundsHelper(system);
  await renderer.renderAsync(scene, camera);
  await renderer.backend.device.queue.onSubmittedWorkDone();
  const helper = gas._brickHelper;
  const result = { covered, retainsSupport, boundedExport,
    retainedDensity: observed.every(brick => brick.maximumExportDensity > 0.9),
    sameFields: fields === gas.velocityCurrentAttribute, sameTexture: texture === gas.densityTexture,
    helperInstances: helper.geometry.instanceCount, logicalBricks: sparse.brickCount, capacity: sparse.capacity,
    helperDirectory: helper.grid === sparse,
    helperRectangle: gas._gridBoundsHelper.box.equals(sparse.bounds) };
  gas.ensureTextureCapacity = allocation;
  system.destroy();
  return result;
};

window.ready = true;

// Direct compatible growth: no simulation tick is allowed to hide a migration mismatch.
window.measureFlipCapacity = async () => {
  const { simulation: fluid, system } = await create('flip', true);
  const grid = fluid.workGrid, projection = fluid.getPressureProjection();
  renderer.compute(grid.compute(index => {
    fluid.velocityBefore.element(index).assign(vec4(7, 8, 9, 0.25));
    fluid.solidVelocity.element(index).assign(vec4(-1, -2, -3, 0));
  }));
  const attributes = [...fields.map(key => fluid[key]), ...projection.capacityAttributes()];
  const values = await Promise.all(attributes.map(read));
  const programs = [fluid.gatherNode, fluid.forceNodeCompute, fluid.transferNode,
    ...projection.pressureNodes, ...projection.fallbackPressureNodes];
  const beforeNode = fluid.velocityBefore;
  const accessorAttribute = new StorageBufferAttribute(new Float32Array(4), 4);
  bindStorageAttributeLifetime(renderer, accessorAttribute);
  const output = storage(accessorAttribute, 'vec4', 1);
  const accessor = Fn(() => output.element(0).assign(fluid.velocityBefore.element(17)))().compute(1);
  renderer.compute(accessor);
  await renderer.backend.device.queue.onSubmittedWorkDone();
  const pool = fluid.workPool;
  let pipelines = 0;
  const createPipeline = renderer.backend.createComputePipeline;
  renderer.backend.createComputePipeline = function (...args) {
    pipelines++; return createPipeline.apply(this, args);
  };
  try {
    const start = performance.now();
    pool.request(256); await pool.whenPrepared();
    const preparationMs = performance.now() - start;
    const commitStart = performance.now();
    if (!pool.commit()) throw new Error('Compatible capacity candidate did not commit.');
    const adoptionCPUms = performance.now() - commitStart;
    await renderer.backend.device.queue.onSubmittedWorkDone();
    const fencedMs = performance.now() - commitStart;
    const next = [...fields.map(key => fluid[key]), ...projection.capacityAttributes()];
    const after = await Promise.all(next.map(read));
    let exact = true, newTailZero = true;
    for (let i = 0; i < values.length; i++) {
      const planes = i === 0 || i === 5 ? 2 : 1;
      const oldStride = values[i].length / planes, newStride = after[i].length / planes;
      const scalarStride = i < fields.length ? attributes[i].itemSize : i === fields.length + 2 ? 7 :
        i === fields.length + 3 ? 6 : 4;
      for (let plane = 0; plane < planes; plane++) {
        for (let j = 0; j < oldStride - scalarStride; j++)
          exact &&= values[i][plane * oldStride + j] === after[i][plane * newStride + j];
        for (let j = oldStride - scalarStride; j < newStride; j++)
          newTailZero &&= after[i][plane * newStride + j] === 0;
      }
    }
    const samePrograms = grid === fluid.workGrid && projection === fluid.getPressureProjection()
      && programs.every((node, i) => node === [fluid.gatherNode, fluid.forceNodeCompute, fluid.transferNode,
        ...projection.pressureNodes, ...projection.fallbackPressureNodes][i]) && beforeNode === fluid.velocityBefore;
    // An actual dispatch verifies the packed before-velocity accessor after rebinding.
    renderer.compute(accessor);
    const first = await read(accessorAttribute);
    accessor.dispose(); accessorAttribute.dispose();
    return { capacity: grid.capacity, pipelines, preparationMs, adoptionCPUms, fencedMs,
      exact, newTailZero, samePrograms, beforePlane: [...first], metrics: { ...pool.metrics } };
  } finally {
    renderer.backend.createComputePipeline = createPipeline;
    system.destroy();
    await renderer.backend.device.queue.onSubmittedWorkDone();
  }
};
