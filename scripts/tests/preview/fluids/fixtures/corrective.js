import * as THREE from 'three';
import { WebGPURenderer, StorageBufferAttribute } from 'three/webgpu';
import { Fn, atomicStore, float, instanceIndex, storage, uint, uniform, vec3, vec4 } from 'three/tsl';
import { Emitter, GasSimulation, FLIPSimulation, ParticleSystem, FluidCollider, VolumeRenderer } from '@rzmps/rzmps';

const renderer = new WebGPURenderer({ trackTimestamp: true });
await renderer.init();
const parameters = new URLSearchParams(location.search);
const bricks = Number(parameters.get('bricks') ?? 2);
const cells = Number(parameters.get('cells') ?? 2);
const sourceCount = Number(parameters.get('sources') ?? 1);
const activeCount = Number(parameters.get('active') ?? 64);
const constructorStart = performance.now();
const gas = new GasSimulation({
  bounds: new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)),
  boundsPadding: 0, automaticPadding: false, adaptiveTimestep: false,
  spatialGridOptions: { brickSubdivisions: bricks, cellSubdivisions: cells },
  initialBrickCapacity: 4, maxBrickCapacity: 64,
  pressureDiagnostics: true, externalForce: new THREE.Vector3(), maxVelocity: 100,
});
const system = new ParticleSystem({ gpuProcessing: true, maxParticles: Math.max(sourceCount, 8),
  gravity: new THREE.Vector3(),
  emitters: new Emitter({ rate: 0, bursts: [{ time: 0, count: sourceCount }], initialValues: {
    lifetime: 100, mass: 1, speed: 1, scale: new THREE.Vector3(0.2, 0.2, 0.2), velocity: new THREE.Vector3(),
  } }), modules: gas, renderers: [],
});
const constructionMs = performance.now() - constructorStart;
const scene = new THREE.Scene();
scene.add(system);
if (parameters.has('obstacle')) {
  const obstacle = parameters.get('obstacle') === 'sphere' ? FluidCollider.Sphere({}, 0.35, 12, 8)
    : FluidCollider.Box({}, 0.15, 1.1, 1.1);
  obstacle.rotation.z = Math.PI / 4;
  scene.add(obstacle);
  gas.explicitSpatialEffects = [obstacle];
}
const camera = new THREE.PerspectiveCamera();
const read = async attribute => new Float32Array(await renderer.getArrayBufferAsync(attribute));
window.testPreparation = async () => {
  const before = { time: system._elapsedTime, particles: system.liveParticleCount };
  const prepareStart = performance.now();
  await system.prepare(renderer);
  await renderer.backend.device.queue.onSubmittedWorkDone();
  const prepareMs = performance.now() - prepareStart;
  const renderStart = performance.now();
  await renderer.renderAsync(scene, camera);
  await renderer.backend.device.queue.onSubmittedWorkDone();
  const firstRenderAfterPrepareMs = performance.now() - renderStart;
  return { constructionMs, prepareMs, firstRenderAfterPrepareMs, before,
    after: { time: system._elapsedTime, particles: system.liveParticleCount } };
};
window.testGrowth = async () => {
  const firstUpdateStart = performance.now();
  system.advanceFrames(1, 1 / 60);
  const firstUpdateCpuMs = performance.now() - firstUpdateStart;
  await renderer.backend.device.queue.onSubmittedWorkDone();
  const firstUpdateFencedMs = performance.now() - firstUpdateStart;
  const seed = gas.computeCells(index => {
    gas.densityCurrent.element(index).assign(vec4(2, 3, 4, 5));
    gas.colorCurrent.element(index).assign(vec4(0.3, 0.4, 0.5, 0));
    gas.velocityCurrent.element(index).assign(vec4(1, 2, 3, 0));
    gas.pressureCurrent.element(index).assign(7);
    gas.solidVelocity.element(index).assign(vec4(4, 5, 6, 0));
    gas.visualColor.element(index).assign(vec4(0.2, 0.3, 0.4, 0));
  });
  renderer.compute(seed);
  const count = gas.cellCount - 1;
  const before = { density: await read(gas.densityCurrent.value ?? gas.densityAttributeA),
    velocity: await read(gas.velocityCurrentAttribute), pressure: await read(gas.pressureCurrentAttribute),
    wallVelocity: (await read(gas.boundaryAttribute)).slice(gas.cellCount * 4),
    visualColor: (await read(gas.visualAttribute)).slice(gas.cellCount * 4) };
  const capacity = gas.volumeGrid.capacity;
  const previousBytes = gas.allocatedBytes;
  const device = renderer.backend.device;
  const supportsTimestamp = device.features.has('timestamp-query');
  const queries = supportsTimestamp ? device.createQuerySet({ type: 'timestamp', count: 4 }) : null;
  const resolve = supportsTimestamp ? device.createBuffer({ size: 32,
    usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }) : null;
  const result = supportsTimestamp ? device.createBuffer({ size: 32,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }) : null;
  const timerPipeline = supportsTimestamp ? device.createComputePipeline({ layout: 'auto', compute: {
    module: device.createShaderModule({ code: `
      @group(0) @binding(0) var<storage, read_write> marker: atomic<u32>;
      @compute @workgroup_size(1) fn main() { atomicAdd(&marker, 1u); }
    ` }), entryPoint: 'main' } }) : null;
  const marker = supportsTimestamp ? device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE }) : null;
  const group = supportsTimestamp ? device.createBindGroup({ layout: timerPipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: marker } }] }) : null;
  const stamp = (encoder, first) => {
    const pass = encoder.beginComputePass({ timestampWrites: { querySet: queries,
      beginningOfPassWriteIndex: first, endOfPassWriteIndex: first + 1 } });
    pass.setPipeline(timerPipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(1); pass.end();
  };
  const migrate = gas.poolAllocation.options.migrate;
  gas.poolAllocation.options.migrate = (current, replacement) => {
    const before = supportsTimestamp ? device.createCommandEncoder() : null;
    if (before) {
      stamp(before, 0);
      device.queue.submit([before.finish()]);
    }
    migrate(current, replacement);
    if (supportsTimestamp) {
      const after = device.createCommandEncoder();
      stamp(after, 2);
      after.resolveQuerySet(queries, 0, 4, resolve, 0);
      after.copyBufferToBuffer(resolve, 0, result, 0, 32);
      device.queue.submit([after.finish()]);
    }
  };
  const growStart = performance.now();
  let ready = false;
  const growth = gas.growBrickPool(renderer, 64).finally(() => { ready = true; });
  const visibleFrames = [];
  // Keep submitting display frames against current resources while replacement pipelines prepare.
  while (!ready) {
    const frameStart = performance.now();
    await renderer.renderAsync(scene, camera);
    visibleFrames.push(performance.now() - frameStart);
    await new Promise(resolve => setTimeout(resolve, 16));
  }
  await growth;
  const growthWallMs = performance.now() - growStart;
  let migrationGPUIntervalMs = null;
  if (supportsTimestamp) {
    await result.mapAsync(GPUMapMode.READ);
    const values = new BigUint64Array(result.getMappedRange());
    migrationGPUIntervalMs = Number(values[2] - values[1]) / 1e6;
    result.unmap(); queries.destroy(); resolve.destroy(); result.destroy(); marker.destroy();
  }
  gas.poolAllocation.options.migrate = migrate;
  const growthMetrics = { ...gas.poolAllocation.metrics, growthWallMs, migrationGPUIntervalMs,
    visibleFrames: visibleFrames.length, frameHitchesOver50ms: visibleFrames.filter(ms => ms > 50).length,
    maximumFrameCpuMs: Math.max(0, ...visibleFrames), temporaryPeakBytes: previousBytes + gas.allocatedBytes };
  const after = { density: await read(gas.densityCurrent.value ?? gas.densityAttributeA),
    velocity: await read(gas.velocityCurrentAttribute), pressure: await read(gas.pressureCurrentAttribute),
    wallVelocity: (await read(gas.boundaryAttribute)).slice(gas.cellCount * 4),
    visualColor: (await read(gas.visualAttribute)).slice(gas.cellCount * 4) };
  return { growthMetrics, capacity, next: gas.volumeGrid.capacity, firstUpdateCpuMs, firstUpdateFencedMs,
    mismatchedFields: Object.keys(before).filter(key => {
      const channels = key === 'pressure' ? 1 : 4;
      return before[key].slice(0, count * channels).some((value, index) => value !== after[key][index]);
    }),
    retained: Object.keys(before).every(key => {
    const channels = key === 'pressure' ? 1 : 4;
    return before[key].slice(0, count * channels).every((value, index) => value === after[key][index]);
  }) };
};
const activate = () => {
  const grid = gas.volumeGrid;
  const count = Math.min(activeCount, grid.capacity);
  renderer.compute(Fn(() => grid.pages.element(instanceIndex).assign(0))().compute(grid.brickCount));
  renderer.compute(Fn(() => {
    grid.slots.element(instanceIndex).assign(instanceIndex.lessThan(count).select(instanceIndex.add(uint(1)), uint(0)));
    grid.fresh.element(instanceIndex).assign(instanceIndex.lessThan(count).select(uint(1), uint(0)));
  })().compute(grid.capacity));
  renderer.compute(Fn(() => grid.pages.element(instanceIndex).assign(instanceIndex.add(uint(1))))().compute(count));
  grid.updateDispatch(renderer);
};
window.testProjection = async solver => {
  activate();
  gas.pressureSolver = solver;
  gas.pressureWarmStart = false;
  gas.pressureIterations = 16;
  gas.pressureMinIterations = 0;
  gas.pressureMaxIterations = 16;
  gas.pressureTolerance = 0;
  renderer.compute(gas.computeCells(index => {
    const c = gas.cellCoordinate(index);
    const v = float(c.x).add(0.5).div(gas.resolution).mul(Math.PI * 2).sin();
    gas.velocityNext.element(index).assign(vec4(v, 0, 0, 0));
    gas.faceOpenness.element(index).assign(vec4(1));
    gas.solidVelocity.element(index).assign(vec4(0));
  }));
  gas.computeSolidField({ system, deltaTimeNode: uniform(1 / 60) }, renderer);
  const timestampUID = renderer.backend.getTimestampUID;
  const timestamps = [];
  let dispatch = 0;
  renderer.backend.getTimestampUID = function (...args) {
    const uid = timestampUID.apply(this, args).replace(/:f(\d+)$/, `-pressure${dispatch++}:f$1`);
    timestamps.push(uid);
    return uid;
  };
  const start = performance.now();
  gas.solveProjection(renderer, gas.velocityNext, gas.velocityCurrent);
  const submitMs = performance.now() - start;
  renderer.backend.getTimestampUID = timestampUID;
  await renderer.backend.device.queue.onSubmittedWorkDone();
  const fencedMs = performance.now() - start;
  await renderer.resolveTimestampsAsync('compute');
  const resolved = renderer.backend.timestampQueryPool?.compute?.timestamps;
  const gpuMs = resolved && timestamps.every(uid => resolved.has(uid))
    ? timestamps.reduce((sum, uid) => sum + resolved.get(uid), 0) : null;
  gas.benchmarks.start({ maxSamples: 64 });
  if (gpuMs !== null) gas.benchmarks.record('pressureSolveGPU', gpuMs, {
    type: 'span', unit: 'ms', domain: 'gpu', source: 'WebGPU timestamp queries for pressure dispatches',
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  const stats = await gas.getPressureProjection().readDiagnostics(renderer, gas.velocityCurrent);
  return { ...stats, submitMs, fencedMs, gpuMs, allocatedBytes: gas.allocatedBytes,
    activeBricks: Math.min(activeCount, gas.volumeGrid.capacity), allocatedBricks: gas.volumeGrid.capacity };
};
window.testEarlyStop = async () => {
  gas.pressureMinIterations = 2;
  gas.pressureMaxIterations = 20;
  gas.pressureTolerance = 1e-5;
  gas.pressureWarmStart = false;
  renderer.compute(gas.computeCells(index => gas.velocityNext.element(index).assign(vec4(0))));
  gas.solveProjection(renderer, gas.velocityNext, gas.velocityCurrent);
  await renderer.backend.device.queue.onSubmittedWorkDone();
  await new Promise(resolve => setTimeout(resolve, 20));
  return gas.getPressureProjection().readDiagnostics(renderer, gas.velocityCurrent);
};
window.testBoundary = async () => {
  const wall = FluidCollider.Box({}, 0.22, 1, 1);
  wall.position.x = 0.06;
  scene.add(wall);
  gas.explicitSpatialEffects = [wall];
  system.advanceFrames(1, 1 / 60);
  const openness = await read(gas.boundaryAttribute);
  const count = gas.cellCount;
  let partial = 0;
  for (let index = 0; index < count; index++) for (let axis = 0; axis < 3; axis++) {
    const value = openness[index * 4 + axis];
    if (value > 0 && value < 1) partial++;
  }
  wall.position.x += 0.125;
  system.advanceFrames(1, 1 / 60);
  const moving = await read(gas.boundaryAttribute);
  const wallSpeed = Math.max(...moving.slice(count * 4).filter((_, i) => i % 4 === 0));
  system.advanceFrames(1, 1 / 60);
  const resting = await read(gas.boundaryAttribute);
  const stationarySpeed = Math.max(...resting.slice(count * 4).map(Math.abs));
  return { partial, wallSpeed, stationarySpeed };
};
window.ready = true;

window.testTransfer = async (picRatio, resize = false) => {
  const flip = new FLIPSimulation({ bounds: new THREE.Box3(new THREE.Vector3(-1, -1, -1),
    new THREE.Vector3(1, 1, 1)), boundsPadding: 0, automaticPadding: false, adaptiveTimestep: false,
    spatialGridOptions: { brickSubdivisions: 2, cellSubdivisions: 2 },
    externalForce: new THREE.Vector3(), pressureIterations: 0, particleSeparation: 0, picRatio, spatialEffects: [],
  });
  const liquid = new ParticleSystem({ gpuProcessing: true, maxParticles: 64, gravity: new THREE.Vector3(),
    emitters: new Emitter({ rate: 0, bursts: [{ time: 0, count: 64 }], initialValues: {
      lifetime: 100, mass: 1, speed: 1, scale: new THREE.Vector3(0.2, 0.2, 0.2), velocity: new THREE.Vector3(),
    } }), modules: flip, renderers: [],
  });
  scene.add(liquid);
  await renderer.renderAsync(scene, camera);
  liquid.advanceFrames(1, 1 / 120);
  const buffers = liquid.gpuSimulation._gpuBuffers;
  renderer.compute(Fn(() => {
    const particle = buffers.storage.createParticle(undefined, true);
    const position = vec3(float(instanceIndex.mod(4)), float(instanceIndex.div(4).mod(4)),
      float(instanceIndex.div(16).mod(4))).sub(1.5).mul(0.15);
    particle.position.assign(position);
    particle.velocity.assign(resize ? vec3(0.7, 0.2, 0) : vec3(position.y.negate(), position.x, 0));
    buffers.storage.storeParticle(particle);
  })().compute(buffers.count));
  liquid.benchmarks.start({ maxSamples: 64 });
  liquid.advanceFrames(1, 1 / 120);
  await renderer.backend.device.queue.onSubmittedWorkDone();
  await new Promise(resolve => setTimeout(resolve, 20));
  const metrics = flip.benchmarks.snapshot();
  let resized;
  if (resize) {
    const before = (await liquid.selectiveReadback(64, ['velocity'])).filter(p => p.valid);
    const previous = flip.bounds.clone();
    // Deliberately stale pressure must not survive a world-to-grid remapping.
    renderer.compute(flip.computeCells(index => { flip.pressureCurrent.element(index).assign(30); }));
    flip.pressureIterations = 32;
    flip.pendingBounds = { grid: flip.getParticleSpatialGrid(liquid), bounds: previous.clone().expandByScalar(1) };
    liquid.advanceFrames(1, 1 / 120);
    const after = (await liquid.selectiveReadback(64, ['velocity'])).filter(p => p.valid);
    resized = { previousSide: previous.getSize(new THREE.Vector3()).x,
      side: flip.bounds.getSize(new THREE.Vector3()).x,
      before: before.reduce((sum, p) => sum + p.particle.velocity.length(), 0) / before.length,
      after: after.reduce((sum, p) => sum + p.particle.velocity.length(), 0) / after.length };
  }
  liquid.destroy();
  scene.remove(liquid);
  return { picRatio, resized, ...metrics };
};

let boundaryHelper;
window.visualizeBoundary = async (mode = 'faces') => {
  if (boundaryHelper) {
    scene.remove(boundaryHelper);
    boundaryHelper.traverse(object => { object.geometry?.dispose(); object.material?.dispose(); });
  }
  boundaryHelper = new THREE.Group();
  const values = await read(gas.boundaryAttribute);
  const grid = gas.volumeGrid;
  const pages = new Uint32Array(await renderer.getArrayBufferAsync(grid.pagesAttribute));
  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();
  const size = gas.cellSize;
  const side = gas.resolution;
  for (let axis = 0; axis < (mode === 'faces' ? 3 : 1); axis++) {
    const geometry = mode === 'faces' ? new THREE.PlaneGeometry(size * 0.85, size * 0.85)
      : new THREE.BoxGeometry(size * 0.85, size * 0.85, size * 0.85);
    if (mode === 'faces' && axis === 0) geometry.rotateY(Math.PI / 2);
    if (mode === 'faces' && axis === 1) geometry.rotateX(Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true,
      opacity: 0.65, depthWrite: false });
    const mesh = new THREE.InstancedMesh(geometry, material, grid.cellCount);
    let count = 0;
    for (let z = 0; z < side; z++) for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
      const b = grid.brickSide, bricks = side / b;
      const page = pages[Math.floor(x / b) + bricks * (Math.floor(y / b) + bricks * Math.floor(z / b))];
      if (!page) continue;
      const address = (page - 1) * b ** 3 + x % b + b * (y % b + b * (z % b));
      const open = values[address * 4 + (mode === 'faces' ? axis : 3)];
      if (open >= 1) continue;
      const position = new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5).multiplyScalar(size).add(gas.bounds.min);
      if (mode === 'faces') position.setComponent(axis, position.getComponent(axis) - size * 0.5);
      mesh.setMatrixAt(count, matrix.makeTranslation(position));
      mesh.setColorAt(count, color.setRGB(1 - open, open, 0.15));
      count++;
    }
    mesh.count = count;
    boundaryHelper.add(mesh);
  }
  scene.add(boundaryHelper);
  camera.aspect = 1;
  camera.far = 100;
  camera.position.set(2, 1.5, 2);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  renderer.setSize(640, 640);
  if (!renderer.domElement.parentElement) document.body.append(renderer.domElement);
  await renderer.renderAsync(scene, camera);
};

window.traceMultigrid = async () => {
  const pending = [];
  for (const [index, level] of gas.getPressureProjection().multigrid.levels.entries()) {
    for (const name of ['restrict', 'smooth', 'prolong']) {
      const original = level[name];
      level[name] = function (...args) {
        const result = original.apply(this, args);
        const sample = renderer.getArrayBufferAsync(level.valuesAttribute).then(buffer => {
          const values = new Float32Array(buffer);
          let maxPressure = 0, maxRHS = 0, nonfinite = 0, active = 0;
          for (let i = 0; i < values.length; i += 4) {
            if (values[i + 2] <= 0) continue;
            active++;
            if (!Number.isFinite(values[i]) || !Number.isFinite(values[i + 1])) nonfinite++;
            else { maxPressure = Math.max(maxPressure, Math.abs(values[i]));
              maxRHS = Math.max(maxRHS, Math.abs(values[i + 1])); }
          }
          return { index, name, maxPressure, maxRHS, nonfinite, active };
        });
        pending.push(sample);
        return result;
      };
    }
  }
  const stats = await window.testProjection('Multigrid');
  return { stats, trace: await Promise.all(pending) };
};

window.testRestart = async () => {
  system.clearParticles();
  system.start();
  system.advanceFrames(1, 1 / 60);
  const values = await read(gas.densityCurrent.value);
  let maxDensity = 0, nonfinite = 0;
  for (let i = 0; i < values.length; i += 4) {
    if (!Number.isFinite(values[i])) nonfinite++;
    else maxDensity = Math.max(maxDensity, values[i]);
  }
  return { maxDensity, nonfinite, capacity: gas.volumeGrid.capacity };
};


window.testSparseAllocation = async () => {
  const Grid = gas.volumeGrid.constructor;
  const grid = new Grid({ brickSubdivisions: 2, cellSubdivisions: 1 }, 4);
  grid.rebuild({ buffers: system.gpuSimulation._gpuBuffers, deltaTimeNode: float(0) }, renderer,
    undefined, undefined, vec3(-1), float(0.25), float(0), 0);
  const request = async bricks => {
    renderer.compute(grid.resetNode);
    renderer.compute(Fn(() => {
      for (const brick of bricks) atomicStore(grid.requests.element(brick), uint(1));
    })().compute(1));
    renderer.compute(grid.releaseNode);
    renderer.compute(grid.allocateNode);
    grid.updateDispatch(renderer);
    return {
      pages: [...new Uint32Array(await renderer.getArrayBufferAsync(grid.pagesAttribute))].slice(0, grid.brickCount),
      counters: [...new Uint32Array(await renderer.getArrayBufferAsync(grid.diagnosticsAttribute))],
    };
  };
  const full = await request([0, 1, 2, 3, 4, 5]);
  const retained = full.pages.flatMap((page, brick) => page ? [brick] : []).slice(0, 2);
  const recycled = await request([...retained, 6, 7, 8, 9]);
  const empty = await request([]);
  grid.dispose(renderer);
  return { full, recycled, retained, empty };
};

window.testBoundaryRemoval = async () => {
  const existing = [];
  scene.traverse(object => { if (object instanceof FluidCollider) existing.push(object); });
  existing.forEach(object => object.removeFromParent());
  gas.explicitSpatialEffects = undefined;
  const wall = FluidCollider.Box({}, 0.5, 1, 1);
  scene.add(wall);
  system.advanceFrames(1, 1 / 60);
  const blocked = await gas.readBoundaryDiagnostics(renderer);
  scene.remove(wall);
  system.advanceFrames(1, 1 / 60);
  const removed = await gas.readBoundaryDiagnostics(renderer);
  const volume = new VolumeRenderer({ field: gas.getVolumeField() });
  system.addRenderer(volume);
  system.pause();
  const time = system._elapsedTime, version = gas.getVolumeField().version;
  volume.opacity = 0.41; volume.steps = 79; volume.colorByTemperature = null;
  system.update();
  const paused = { time, after: system._elapsedTime, version, afterVersion: gas.getVolumeField().version,
    opacity: volume.gpuOpacity.value, steps: volume.gpuMaterialSteps, color: volume.colorByTemperature };
  system._paused = false;
  system.removeRenderer(volume); volume.destroy();
  return { blocked, removed, paused };
};

window.testFractionalVisualCoverage = async () => {
  const attribute = new StorageBufferAttribute(new Float32Array(gas.cellCount * 4), 4);
  const output = storage(attribute, 'vec4', gas.cellCount);
  renderer.compute(gas.computeCells(index => {
    gas.densityCurrent.element(index).assign(vec4(2, 6, 0, 0));
    gas.velocityCurrent.element(index).assign(vec4(1, 0, 0, 0));
    const coverage = index.mod(3).equal(0).select(0, index.mod(3).equal(1).select(0.25, 1));
    gas.faceOpenness.element(index).assign(vec4(1, 1, 1, coverage));
  }));
  const before = await read(gas.densityCurrent.value);
  renderer.compute(gas.computeCells(index => {
    const physical = gas.densityCurrent.element(index);
    output.element(index).assign(gas.outputParameters(index, physical.x, physical.y));
  }));
  const visual = await read(attribute), after = await read(gas.densityCurrent.value);
  let empty = 0, partial = 0, full = 0, invalidTemperature = 0;
  for (let i = 0; i < gas.cellCount; i++) {
    if (before[i * 4] !== 2) continue;
    const density = visual[i * 4];
    if (density === 0) empty++;
    else if (density === 0.5) partial++;
    else if (density === 2) full++;
    if (density > 0 && Math.abs(visual[i * 4 + 1] / density - 3) > 1e-6) invalidTemperature++;
  }
  const physicsUnchanged = before.every((value, index) => value === after[index]);
  attribute.dispose();
  return { empty, partial, full, invalidTemperature, physicsUnchanged };
};

window.debugBehavior = { renderer, scene, camera, THREE, StorageBufferAttribute,
  tsl: { Fn, storage, vec3, vec4, float, uint } };
