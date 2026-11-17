// Imported into fluid.html AFTER window.ready. No independent scene or simulation history.
import { GasSimulation, ParticleSpatialGrid } from '@rzmps/rzmps';
import { uniform } from 'three/tsl';

const assert = (value, message) => { if (!value) throw new Error(message); };
const boxArray = box => [...box.min.toArray(), ...box.max.toArray()];
const tier = side => 2 ** Math.ceil(Math.log2(side) - 1e-6);
export { passTimer } from '../../../../benchmark/gpuPassTimer.js';
import { passTimer } from '../../../../benchmark/gpuPassTimer.js';
const hash = buffer => {
  let value = 2166136261;
  for (const byte of new Uint8Array(buffer)) value = Math.imul(value ^ byte, 16777619) >>> 0;
  return value.toString(16).padStart(8, '0');
};

// Read back outside measured intervals. Density-only counts are candidates, never safe solver masks.
async function residentCensus(renderer, gas) {
  const grid = gas.volumeGrid;
  const [directory, densityBuffer, velocityBuffer] = await Promise.all([
    renderer.getArrayBufferAsync(grid.pagesAttribute),
    renderer.getArrayBufferAsync(gas.densityCurrent.value),
    renderer.getArrayBufferAsync(gas.velocityCurrent.value),
  ]);
  const pages = new Uint32Array(directory), density = new Float32Array(densityBuffer);
  const velocity = new Float32Array(velocityBuffer), occupied = new Set();
  let resident = 0, densityCells = 0, velocityPages = 0, emptyDensityMovingPages = 0;
  for (let key = 0; key < grid.brickCount; key++) {
    if (!pages[key]) continue;
    resident++;
    const start = (pages[key] - 1) * grid.cellsPerBrick;
    let hasDensity = false, hasVelocity = false;
    for (let cell = start; cell < start + grid.cellsPerBrick; cell++) {
      if (density[cell * 4] > 0) { hasDensity = true; densityCells++; }
      if (Math.hypot(...velocity.subarray(cell * 4, cell * 4 + 3)) > 1e-6) hasVelocity = true;
    }
    if (hasDensity) occupied.add(key);
    if (hasVelocity) velocityPages++;
    if (!hasDensity && hasVelocity) emptyDensityMovingPages++;
  }
  const n = grid.brickDimensions, ring = new Set(occupied);
  for (const key of occupied) {
    const x = key % n.x, y = Math.floor(key / n.x) % n.y, z = Math.floor(key / (n.x * n.y));
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const i = x + dx, j = y + dy, k = z + dz;
      if (i < 0 || j < 0 || k < 0 || i >= n.x || j >= n.y || k >= n.z) continue;
      const neighbor = i + n.x * (j + n.y * k);
      if (pages[neighbor]) ring.add(neighbor);
    }
  }
  assert(occupied.size <= resident && velocityPages <= resident, 'Invalid stage support census');
  return { residentPages: resident, densityPages: occupied.size, densityCells,
    residentCells: resident * grid.cellsPerBrick, velocityPages, emptyDensityMovingPages,
    densityPlusOneBrickRing: ring.size, outsideDensityRing: resident - ring.size,
    note: 'Exact positive density; velocity epsilon 1e-6. Ring excludes source/effect and backtrace support.' };
}

window.runVolumeQuality = async ({ warmup = 5, samples = 12, stageAudit = false } = {}) => {
  const { renderer, system, flip: original, scene, camera, THREE } = window.debugFluid;
  const device = renderer.backend.device;
  const fence = () => device.queue.onSubmittedWorkDone();
  const drain = async () => {
    await renderer.resolveTimestampsAsync('compute');
    await renderer.resolveTimestampsAsync('render');
    await fence();
  };
  assert(original instanceof GasSimulation && system.isGPUProcessingActive, 'Requires native GPU gas fixture');
  let capturedContext, capturedRender;
  const compute = original.computeGPU, render = original.renderGPU;
  original.computeGPU = function (context, ...args) {
    capturedContext = context;
    return compute.call(this, context, ...args);
  };
  original.renderGPU = function (context, buffers, ...args) {
    capturedRender = buffers;
    return render.call(this, context, buffers, ...args);
  };
  const warmPipelines = [], backend = renderer.backend;
  const pipeline = backend.createComputePipeline;
  backend.createComputePipeline = function (...args) {
    const start = performance.now();
    try { return pipeline.apply(this, args); }
    finally { warmPipelines.push({ cpuMs: performance.now() - start, time: system._elapsedTime }); }
  };
  const warmChanges = { ...original.domainChanges }, warmStart = performance.now(), qualityHistory = [];
  const selectionRule = { minimumUpdates: 30, maximumUpdates: 120, yieldMs: 16,
    condition: stageAudit ? 'capture update 50 at the actual active tier'
      : 'first actualActiveTier >= 4 and rawTargetCubeTier > actualActiveTier',
    cubeMetric: 'raw domainTarget for capture; enclosing captured bounds for fixed B',
    pacing: 'advanceFrames(1, 1/60), renderAsync, drain timestamps/fence, yield' };
  let captureUpdates = 1, contrastFound = false;
  try {
    // fluid.js has advanced once. Select the first contrast state, with bounded display-like pacing.
    for (; captureUpdates < selectionRule.maximumUpdates;) {
      system.advanceFrames(1, 1 / 60);
      captureUpdates++;
      await renderer.renderAsync(scene, camera);
      await drain();
      await new Promise(resolve => setTimeout(resolve, selectionRule.yieldMs));
      const activeTier = original.spatialGrid.volumeQualityTier;
      const rawSize = original.spatialGrid.domainTarget.getSize(new THREE.Vector3());
      const boundsSize = original.bounds.getSize(new THREE.Vector3());
      const cubeTier = tier(Math.max(...rawSize.toArray()));
      const allocatedCubeTier = tier(Math.max(...boundsSize.toArray()));
      qualityHistory.push({ update: captureUpdates, tier: activeTier, cubeTier, allocatedCubeTier,
        qualityChanges: original.domainChanges.quality });
      if (stageAudit ? captureUpdates >= 50
        : captureUpdates >= selectionRule.minimumUpdates && activeTier >= 4 && cubeTier > activeTier) {
        contrastFound = true;
        break;
      }
    }
    assert(contrastFound, `No contrast state found by update ${captureUpdates}: `
      + JSON.stringify(qualityHistory.slice(-5)));
  } finally {
    original.computeGPU = compute; original.renderGPU = render;
    backend.createComputePipeline = pipeline;
  }
  assert(capturedContext && capturedRender, 'Missing captured GPU context/render buffers');
  system.pause(false);
  const context = { ...capturedContext, deltaTime: 1 / 60, deltaTimeNode: uniform(1 / 60),
    elapsedTimeNode: uniform(capturedContext.elapsedTimeNode.value) };
  const frozenTime = system._elapsedTime, buffers = context.buffers, version = buffers.version;
  const particleAttributes = Object.values(buffers.attributes);
  const particleHashes = async () => Promise.all(particleAttributes.map(async attribute =>
    hash(await renderer.getArrayBufferAsync(attribute))));
  const identity = await particleHashes();
  const raw = original.spatialGrid.domainTarget.clone(), rawSize = raw.getSize(new THREE.Vector3());
  const size = original.bounds.getSize(new THREE.Vector3());
  const qualityA = original.spatialGrid.volumeQualityTier;
  const qualityB = stageAudit ? qualityA : tier(Math.max(...rawSize.toArray(), ...size.toArray()));
  const coarseBrick = qualityB / original.resolution * original.volumeGrid.brickSide;
  const bounds = original.bounds.clone();
  for (const axis of stageAudit ? [] : ['x', 'y', 'z']) {
    bounds.min[axis] = Math.floor(bounds.min[axis] / coarseBrick) * coarseBrick;
    bounds.max[axis] = Math.ceil(bounds.max[axis] / coarseBrick) * coarseBrick;
  }
  let anisotropyPadding = 0;
  const alignedSize = bounds.getSize(new THREE.Vector3());
  if (!stageAudit && alignedSize.x === alignedSize.y && alignedSize.y === alignedSize.z) {
    bounds.max.y += coarseBrick;
    anisotropyPadding = coarseBrick;
  }
  const warmWallMs = performance.now() - warmStart;
  const capacity = original.volumeGrid.capacity;
  const sourcePages = new Uint32Array(await renderer.getArrayBufferAsync(original.volumeGrid.pagesAttribute));
  const sourceGrid = original.volumeGrid;
  const originalModules = system.modules;
  const volume = system.renderers.find(component => 'dynamicResolution' in component);
  assert(volume, 'Missing volume renderer');
  volume.dynamicResolution = false;
  const renderSettings = Object.fromEntries(['steps', 'samplesPerVoxel', 'downsample', 'dynamicResolution',
    'emptySpaceSkipping', 'jitterStrength', 'noiseTime'].map(key => [key, volume[key]]));
  const cameraState = { projection: camera.projectionMatrix.toArray(), world: camera.matrixWorld.toArray(),
    size: renderer.getSize(new THREE.Vector2()).toArray(), pixelRatio: renderer.getPixelRatio() };
  const result = { valid: false, method: 'frozen fields and particles; one transport+projection+volume render replay',
    capture: { updates: captureUpdates, selectionRule, elapsedTime: frozenTime, particles: system.liveParticleCount,
      particleHashes: identity, particleVersion: version, originalBounds: boxArray(original.bounds),
      originalSize: size.toArray(), rawDomainTarget: boxArray(raw), rawTargetSize: rawSize.toArray(),
      instantaneousEquivalentTier: tier(Math.cbrt(rawSize.x * rawSize.y * rawSize.z)),
      instantaneousCubeTier: tier(Math.max(...rawSize.toArray())), actualActiveTier: qualityA,
      pendingRequestedTier: original.spatialGrid.qualityRequest?.tier ?? null,
      qualityLimits: { min: original.spatialGridOptions.minVolumeQuality ?? 2,
        max: original.spatialGridOptions.maxVolumeQuality ?? 'Infinity' },
      hysteresis: { upperFactor: 1.1, lowerFactor: 0.45,
        note: 'Actual tier retained; target is not recomputed from snapped bounds.', qualityHistory },
      warmState: { wallMs: warmWallMs, before: warmChanges,
        after: { ...original.domainChanges }, pipelines: warmPipelines }, capacity },
    controls: { bounds: boxArray(bounds), coarseBrick, anisotropyPadding, capacity, dt: 1 / 60,
      pressureIterations: original.pressureIterations, pressureWarmStart: false, pressureTolerance: 0,
      renderSettings, camera: cameraState, warmup, samples }, candidates: [] };

  // GPU copies keep full field bits, source masks, and page identities outside measured steps.
  const snapshot = attributes => [...new Set(attributes)].flatMap(attribute => {
    const live = backend.get(attribute).buffer;
    if (!live) return [];
    const saved = device.createBuffer({ size: live.size,
      usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    const encoder = device.createCommandEncoder(); encoder.copyBufferToBuffer(live, 0, saved, 0, live.size);
    device.queue.submit([encoder.finish()]);
    return [{ live, saved, size: live.size }];
  });
  const restore = copies => {
    const encoder = device.createCommandEncoder();
    for (const copy of copies) encoder.copyBufferToBuffer(copy.saved, 0, copy.live, 0, copy.size);
    device.queue.submit([encoder.finish()]);
  };

  try {
    const candidates = stageAudit ? [['fixed-current-quality-stage-audit', qualityA]]
      : [['A-current-active-auto-tier', qualityA], ['B-enclosing-cube-tier', qualityB]];
    for (const [name, quality] of candidates) {
      const preparationStart = performance.now();
      const gas = new GasSimulation({ ...original, condition: undefined, conditionGPU: undefined,
        spatialEffects: original.explicitSpatialEffects, bounds: bounds.clone(), automaticPadding: false,
        adaptiveTimestep: false, maxFluidSubsteps: 1, pressureWarmStart: false,
        pressureIterations: original.pressureIterations, pressureMinIterations: original.pressureIterations,
        pressureMaxIterations: original.pressureIterations, pressureTolerance: 0, pressureDiagnostics: false,
        initialBrickCapacity: capacity, maxBrickCapacity: capacity, maxActiveBricks: capacity,
        spatialGridOptions: { ...original.spatialGridOptions, bounds: bounds.clone(),
          volumeQuality: quality, autoVolumeQuality: false, minVolumeQuality: quality, maxVolumeQuality: quality,
          minBounds: 0, maxBounds: Infinity, autoExpand: false, autoShrink: false } });
      assert(gas.supportsGPU, 'Candidate is not GPU compatible');
      const grid = new ParticleSpatialGrid(gas.spatialGridOptions);
      gas.spatialGrid = grid;
      system.modules = originalModules.map(module => module === original ? gas : module);
      let copies = [], seedNodes = [];
      try {
        await gas.prepareResources(system, renderer);
        gas.poolContext = context; gas.poolParticleGrid = grid;
        // Constructor caps initial reserve at logical brick count; explicitly prepare the SAME resident pool.
        await gas.growBrickPool(renderer, capacity);
        assert(gas.volumeGrid.capacity === capacity, 'Resident capacity differs');
        assert(gas.bounds.equals(bounds) && grid.bounds.equals(bounds), 'Candidate bounds differ');
        gas.syncSimulationUniforms(); gas.syncBoundsPolicy();
        grid.rebuild(renderer, buffers);
        const target = gas.volumeGrid, keys = new Set();
        const n = sourceGrid.brickDimensions, m = target.brickDimensions;
        // Map the captured resident coverage into each grid, without inventing field values.
        for (let z = 0; z < n.z; z++) for (let y = 0; y < n.y; y++) for (let x = 0; x < n.x; x++) {
          if (!sourcePages[x + n.x * (y + n.y * z)]) continue;
          const low = new THREE.Vector3(x, y, z).multiplyScalar(original.cellSize * sourceGrid.brickSide)
            .add(original.bounds.min).sub(bounds.min).divideScalar(gas.cellSize * target.brickSide);
          const high = low.clone().addScalar(original.cellSize / gas.cellSize);
          for (let k = Math.max(0, Math.floor(low.z)); k < Math.min(m.z, Math.ceil(high.z)); k++) {
            for (let j = Math.max(0, Math.floor(low.y)); j < Math.min(m.y, Math.ceil(high.y)); j++) {
              for (let i = Math.max(0, Math.floor(low.x)); i < Math.min(m.x, Math.ceil(high.x)); i++) {
                keys.add(i + m.x * (j + m.y * k));
              }
            }
          }
        }
        assert(keys.size <= capacity, `Captured coverage requires ${keys.size} pages > ${capacity}`);
        const pages = new Uint32Array(target.pagesAttribute.array.length);
        [...keys].forEach((key, slot) => { pages[key] = slot + 1; pages[target.directoryCapacity + slot] = key + 1; });
        device.queue.writeBuffer(backend.get(target.pagesAttribute).buffer, 0, pages);
        target.updateDispatch(renderer);
        // Current branch signature is sampleField(worldPosition, field).
        seedNodes = ['densityCurrent', 'colorCurrent', 'velocityCurrent'].map(field => gas.computeCells(index => {
          const position = gas.cellCenter(gas.cellCoordinate(index));
          gas[field].element(index).assign(original.sampleField(position, original[field]));
        }));
        seedNodes.forEach(node => renderer.compute(node));
        // Establish source masks and the ordinary receiver ring once, outside measurement.
        target.rebuild(context, renderer, gas.densityCurrent, gas.velocityCurrent,
          gas.boundsMinNode, gas.cellSizeNode, gas.densityCutoffNode, system.getGPUFilterTagMask(gas.tags));
        gas.clearNewBricks(renderer);
        seedNodes.forEach(node => renderer.compute(node));
        gas.computeSolidField(context, renderer);
        gas.updateExportLayout(renderer);
        await drain();
        const diagnostics = await gas.readGridDiagnostics(renderer);
        assert(diagnostics.overflowedBricks === 0, 'Resident capacity denial: result invalid');
        const preparationMs = performance.now() - preparationStart;
        const stageSupportBefore = stageAudit ? await residentCensus(renderer, gas) : undefined;
        const pointers = Object.fromEntries(['densityCurrent', 'densityNext', 'colorCurrent', 'colorNext']
          .map(key => [key, gas[key]]));
        copies = snapshot([...gas.fieldAttributes, ...target.capacityAttributes, target.pagesAttribute,
          target.previousPagesAttribute, target.requestsAttribute, target.requestFramesAttribute,
          ...target.dispatchAttributes]);
        const replayRestore = async () => {
          Object.assign(gas, pointers); restore(copies);
          // initialize() skips reconstruction after its first call. Rebuild MAC faces on EVERY restore
          // so advection cannot sample the previous replay's projected velocity.
          gas.getPressureProjection().build(renderer, gas.velocityCurrent);
          await drain();
        };
        const pipelineEvents = [], allocations = [];
        let measured = false, stage = 'other', cpu = {};
        const restorers = [];
        for (const method of ['createComputePipeline', 'createRenderPipeline', 'createStorageAttribute']) {
          const fn = backend[method];
          backend[method] = function (...args) {
            const start = performance.now();
            try { return fn.apply(this, args); }
            finally {
              const event = { method, measured, cpuMs: performance.now() - start };
              (method.includes('Pipeline') ? pipelineEvents : allocations).push(event);
            }
          };
          restorers.push(() => { backend[method] = fn; });
        }
        const span = gas.benchmarks.span, rendererCompute = renderer.compute;
        gas.benchmarks.span = function (label, callback) {
          const previous = stage, start = performance.now(); stage = label;
          try { return span.call(this, label, callback); }
          finally { cpu[label] = (cpu[label] ?? 0) + performance.now() - start; stage = previous; }
        };
        renderer.compute = function (nodes, ...args) {
          const previous = stage;
          const names = (Array.isArray(nodes) ? nodes : [nodes]).map(node => node.name ?? '').join(',');
          if (names.includes('rendererOccupancy')) stage = 'volumeOccupancy';
          try { return rendererCompute.call(this, nodes, ...args); }
          finally { stage = previous; }
        };
        const observations = [];
        const timer = passTimer(device, backend, () => stage);
        try {
          for (let replay = -warmup; replay < samples; replay++) {
            measured = false;
            await replayRestore();
            cpu = {};
            measured = replay >= 0;
            timer.start();
            const start = performance.now();
            stage = 'transport';
            gas.computeTransport(context, renderer, grid);
            stage = 'renderGPU';
            gas.renderGPU(context, capturedRender, renderer, grid);
            stage = 'rendererRefresh'; system.updateRenderers(false);
            const submitMs = performance.now() - start;
            stage = 'sceneDraw';
            await renderer.renderAsync(scene, camera);
            const timing = await timer.finish(), { stageGPUms } = timing;
            await fence();
            const frameWallMs = performance.now() - start;
            assert(gas.bounds.equals(bounds) && gas.volumeGrid.capacity === capacity, 'Layout/capacity changed');
            if (measured) observations.push({ replay, submitMs, ...timing, frameWallMs, spanCPUms: cpu,
              volumeOccupancyGPUms: stageGPUms.volumeOccupancy ?? 0,
              pressureTopologyGPUms: stageGPUms.pressureTopology ?? 0,
              pressureSweepsGPUms: stageGPUms.pressureSweeps ?? 0,
              pressureSolveGPUms: Object.entries(stageGPUms).filter(([key]) => key.startsWith('pressure'))
                .reduce((sum, [, value]) => sum + value, 0),
              transportGPUms: Object.entries(stageGPUms).filter(([key]) => !key.startsWith('pressure')
                && !['renderGPU', 'volumeFieldUpdate', 'sourceSpatialIndex', 'rendererRefresh',
                  'volumeOccupancy', 'sceneDraw'].includes(key))
                .reduce((sum, [, value]) => sum + value, 0) });
          }
        } finally {
          timer.dispose();
          renderer.compute = rendererCompute; gas.benchmarks.span = span;
          restorers.forEach(fn => fn());
        }
        const afterHashes = await particleHashes();
        const invariants = { particlesIdentical: identity.every((value, i) => value === afterHashes[i]),
          particleBuffersIdentical: context.buffers === buffers && buffers.version === version,
          timeFrozen: system._elapsedTime === frozenTime, boundsIdentical: gas.bounds.equals(bounds),
          capacityIdentical: target.capacity === capacity, noDeniedPages: diagnostics.overflowedBricks === 0,
          noMeasuredPipelines: !pipelineEvents.some(event => event.measured),
          noMeasuredAllocations: !allocations.some(event => event.measured) };
        result.candidates.push({ name, quality, h: gas.cellSize, dimensions: gas.gridDimensions.toArray(),
          bounds: boxArray(gas.bounds), capacity: target.capacity, activePages: diagnostics.activeBricks,
          activeCells: diagnostics.activeBricks * target.cellsPerBrick, diagnostics,
          stageSupportBefore, stageSupportAfter: stageAudit ? await residentCensus(renderer, gas) : undefined,
          preparation: { wallMs: preparationMs,
            note: 'Resource preparation excludes warmups/replays; event list covers replay warmup and measurement.',
            domainChanges: { ...gas.domainChanges }, pipelineEvents, allocations },
          invariants, afterParticleHashes: afterHashes, samples: observations });
        assert(Object.values(invariants).every(Boolean), `Failed invariants for ${name}`);
      } finally {
        await fence();
        copies.forEach(copy => copy.saved.destroy()); seedNodes.forEach(node => node.dispose());
        system.modules = originalModules; system.updateRenderers(false);
        gas.cleanup(); grid.dispose(renderer);
      }
    }
    result.valid = true;
    result.caveats = [
      ...(stageAudit ? ['Stage audit captures update 50 at unchanged bounds/quality; no A/B comparison.'] : []),
      stageAudit ? 'One candidate locks actual active quality; pending quality transitions are excluded.'
        : 'A locks actual active quality; B locks enclosing-cube quality. Domain selection is outside timing.',
      'Captured fields are trilinearly resampled at candidate cell centers; numerical discretizations differ.',
      'Admission, bounds work, field restoration, resource preparation and particle evolution are excluded.',
      'Total GPU is one gas transport/projection/export plus renderGPU and scene draw, not an advancing preset frame.',
      'Topology is fixed after one untimed receiver/source rebuild; pages, fields and MAC faces restore every replay.',
      'Frame wall time includes timestamp resolution/fencing. GPU stage timings are exclusive innermost spans.',
      'GPU times use fresh per-pass queries; total is their interval union, render excludes overlap with compute.',
      ...(stageAudit ? [] : ['Sequential A then B can retain thermal/order bias; repeat to assess variance.']),
    ];
    return result;
  } catch (error) { result.error = error.stack; return result; }
  finally { system.modules = originalModules; }
};
