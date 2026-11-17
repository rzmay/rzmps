import * as THREE from 'three';
import FluidGuardPrediction from '../../../../../packages/rzmps/src/simulation/gpu/FluidGuardPrediction.ts';
import { WebGPURenderer, StorageBufferAttribute } from 'three/webgpu';
import { Fn, float, instanceIndex, max, storage, uint, vec3, vec4 } from 'three/tsl';
import { Emitter, ParticleSystem, ParticleSpatialGrid, GasSimulation, FLIPSimulation } from '@rzmps/rzmps';

const renderer = new WebGPURenderer({ trackTimestamp: true });
await renderer.init();
const options = { brickSubdivisions: 1, cellSubdivisions: 2 };
const bounds = new THREE.Box3(new THREE.Vector3(-1, -4, -1), new THREE.Vector3(1, 4, 1));
const gas = new GasSimulation({ bounds, spatialGridOptions: options,
  initialBrickCapacity: 64, maxActiveBricks: 64, pressureIterations: 4, pressureDiagnostics: true,
  pressureSolver: 'Multigrid' });
const system = new ParticleSystem({ gpuProcessing: true, maxParticles: 4, gravity: new THREE.Vector3(),
  emitters: new Emitter({ rate: 0, bursts: [{ time: 0, count: 2 }],
    initialValues: { lifetime: 10, scale: new THREE.Vector3(0.2, 0.2, 0.2) } }),
  modules: [], renderers: [] });
const scene = new THREE.Scene(); scene.add(system);
await renderer.renderAsync(scene, new THREE.PerspectiveCamera());
system.advanceFrames(1, 1 / 60);
const buffers = system.gpuSimulation._gpuBuffers;
renderer.compute(Fn(() => {
  const p = buffers.storage.createParticle();
  p.alive.assign(instanceIndex.lessThan(2).select(uint(1), uint(0)));
  p.position.assign(vec3(0, float(instanceIndex).mul(4), 0));
  p.velocity.assign(vec3(0, float(instanceIndex).mul(2), 0));
  p.speed.assign(2); p.lifetime.assign(10); p.realtime.assign(0);
  p.scale.assign(vec3(0.2));
})().compute(4));
const read = async attribute => new Float32Array(await renderer.getArrayBufferAsync(attribute));
const pages = async grid => new Uint32Array(await renderer.getArrayBufferAsync(grid.pagesAttribute));
function activateAll(grid) {
  renderer.compute(Fn(() => {
    grid.pages.element(instanceIndex).assign(instanceIndex.add(1));
    grid.slots.element(instanceIndex).assign(instanceIndex.add(1));
  })().compute(grid.brickCount));
  grid.updateDispatch(renderer);
}
window.checkReactiveDomains = async () => {
  const particleGrid = new ParticleSpatialGrid({ bounds, ...options });
  particleGrid.rebuild(renderer, buffers, {});
  const occupied = await particleGrid.readParticleBounds(renderer);
  const answers = new StorageBufferAttribute(new Uint32Array(2), 1), answer = storage(answers, 'uint', 2);
  renderer.compute(Fn(() => {
    answer.element(0).assign(particleGrid.nearestParticleIndexNode(vec3(0, 0, 0), float(1)));
    const count = uint(0).toVar();
    particleGrid.forEachParticleInRadius(vec3(0, 0, 0), float(0.5), () => count.addAssign(1));
    answer.element(1).assign(count);
  })().compute(1));
  const queries = [...new Uint32Array(await renderer.getArrayBufferAsync(answers))];
  // Compare the exact source integral over identical particles without advancing any demo modules.
  const sourceGrid = gas.getSourceGrid({ system, buffers }, renderer, particleGrid);
  const sums = new StorageBufferAttribute(new Float32Array(128 * 4), 4), sum = storage(sums, 'vec4', 128);
  for (const [offset, index] of [[0, particleGrid], [64, sourceGrid]]) renderer.compute(Fn(() => {
    const position = vec3(0.03, float(instanceIndex).mul(0.07).sub(0.1), 0.02);
    const value = vec4(0).toVar();
    index.forEachParticleInRadius(position, index.getMaxParticleRadiusNode(), (p, distanceSq) => {
      const radius = p.scale.x.abs().max(p.scale.y.abs()).max(p.scale.z.abs()).mul(0.5);
      const weight = float(1).sub(distanceSq.sqrt().div(radius)).max(0).mul(p.alpha).mul(p.mass);
      value.addAssign(vec4(p.color.mul(weight), weight));
    });
    sum.element(instanceIndex.add(offset)).assign(value);
  })().compute(64));
  const integral = await read(sums);
  const sourceError = Math.max(...integral.slice(0, 256).map((value, i) => Math.abs(value - integral[i + 256])));


  // Use the real gas layout replacement path and compare overlapping resident addresses exactly.
  const old = gas.volumeGrid;
  activateAll(old);
  renderer.compute(gas.computeCells(index => {
    const c = gas.cellCenter(gas.cellCoordinate(index));
    gas.densityCurrent.element(index).assign(vec4(c.y.add(3), 2, 0, 0));
    gas.colorCurrent.element(index).assign(vec4(c.x.add(2), c.z.add(2), 1, 0));
    gas.velocityCurrent.element(index).assign(vec4(1, 2, 3, 0));
    gas.velocityNext.element(index).assign(vec4(0));
    gas.solid.element(index).assign(0); gas.faceOpenness.element(index).assign(vec4(1));
  }));
  gas.syncSimulationUniforms();
  gas.reduceFieldMaxima(renderer, gas.densityCurrent);
  const fieldBounds = await gas.readOccupiedFieldBounds(renderer);
  const occupiedSupport = occupied.clone().union(fieldBounds);
  const gasSupportPreserved = occupiedSupport.containsBox(gas.occupiedGasBounds);
  // The real asynchronous bounds path must restore gas guards after every source particle is gone.
  const automatic = new ParticleSpatialGrid({ ...options, autoExpand: false,
    minVolumeQuality: 4, maxVolumeQuality: 4 });
  automatic.setBounds(gas.bounds);
  automatic.readParticleBounds = async () => new THREE.Box3();
  gas.spatialGrid = automatic; gas.autoBounds = true; gas.automaticPadding = true;
  gas.refreshBounds(automatic, renderer);
  for (let i = 0; gas.boundsReadPending && i < 100; i++) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  const requested = gas.pendingBounds?.bounds;
  const gasOnlyGuardRestored = Boolean(requested && gas.particleBounds.isEmpty()
    && ['x', 'y', 'z'].every(axis => requested.min[axis] <= fieldBounds.min[axis] - automatic.brickSize
      && requested.max[axis] >= fieldBounds.max[axis] + automatic.brickSize));
  gas.spatialGrid = undefined; gas.autoBounds = false; gas.automaticPadding = false;
  gas.pendingBounds = undefined;

  // A zero cutoff must still release empty resident halo pages after the sources die.
  const emptyGrid = new old.constructor({ ...options, bounds: gas.bounds }, old.capacity, old.gridDimensions);
  activateAll(emptyGrid);
  const zerosAttribute = new StorageBufferAttribute(new Float32Array(emptyGrid.cellCount * 4), 4);
  const zeros = storage(zerosAttribute, 'vec4', emptyGrid.cellCount);
  emptyGrid.rebuild({ buffers, deltaTimeNode: float(1 / 60) }, renderer, zeros, zeros,
    vec3(gas.bounds.min), float(gas.cellSize), float(0), 0);
  const emptyCutoffReleased = [...(await pages(emptyGrid)).slice(0, emptyGrid.brickCount)].every(value => !value);
  emptyGrid.dispose(renderer); zerosAttribute.dispose();

  const before = await read(gas.densityCurrent.value), oldPages = await pages(old);
  // Build coarse pressure history before exercising a translated and then resized domain.
  gas.solveProjection(renderer, gas.velocityCurrent, gas.velocityNext);
  // Compare cached sweep coefficients against the original operator on the same GPU fields.
  const projection = gas.getPressureProjection();
  const errorsAttribute = new StorageBufferAttribute(new Float32Array(gas.cellCount * 4), 4);
  const errors = storage(errorsAttribute, 'vec4', gas.cellCount);
  renderer.compute(gas.computeCells(index => {
    const coordinate = gas.cellCoordinate(index);
    const reference = projection.stencil(coordinate), cached = projection.cachedStencil(index);
    const difference = max(reference.sum.sub(cached.sum).abs(), reference.diagonal.sub(cached.diagonal).abs());
    errors.element(index).assign(vec4(projection.active(coordinate).select(difference, float(0))));
  }));
  const cachedStencilError = Math.max(...await read(errorsAttribute));
  errorsAttribute.dispose();

  // Liquid occupancy/free surfaces use the same cache but a different pressure-validity rule.
  const liquid = new FLIPSimulation({
    bounds: new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)),
    spatialGridOptions: options, pressureIterations: 2, adaptiveTimestep: false,
  });
  activateAll(liquid.workGrid);
  renderer.compute(liquid.computeCells(index => {
    const c = liquid.cellCoordinate(index), wall = c.y.equal(0);
    liquid.solid.element(index).assign(wall.select(1, 0));
    liquid.faceOpenness.element(index).assign(wall.select(vec4(0), vec4(0.75, 0.5, 0.25, 1)));
    liquid.solidVelocity.element(index).assign(vec4(0));
    liquid.velocityNext.element(index).assign(vec4(0.25, -0.5, 0.1, c.y.lessThan(4).select(2, 1)));
    liquid.velocityBefore.element(index).assign(vec4(0, 0, 0, 1));
  }));
  liquid.solveProjection(renderer, liquid.velocityNext, liquid.velocityCurrent);
  const liquidProjection = liquid.getPressureProjection();
  const liquidErrors = new StorageBufferAttribute(new Float32Array(liquid.cellCount * 4), 4);
  const liquidOutput = storage(liquidErrors, 'vec4', liquid.cellCount);
  renderer.compute(liquid.computeCells(index => {
    const c = liquid.cellCoordinate(index);
    const reference = liquidProjection.stencil(c), cached = liquidProjection.cachedStencil(index);
    const difference = max(reference.sum.sub(cached.sum).abs(), reference.diagonal.sub(cached.diagonal).abs());
    liquidOutput.element(index).assign(vec4(liquidProjection.active(c).select(difference, float(0))));
  }));
  const liquidStencilError = Math.max(...await read(liquidErrors));
  liquidErrors.dispose(); liquid.cleanup();

  const shifted = old.bounds.clone().translate(new THREE.Vector3(0, old.brickSize, 0));
  const target = new ParticleSpatialGrid({ bounds: shifted, ...options,
    minVolumeQuality: 4, maxVolumeQuality: 4 });
  gas.bounds.copy(target.bounds);
  gas.ensureGridResolution(renderer, target);
  const after = await read(gas.densityCurrent.value), nextPages = await pages(gas.volumeGrid);
  let overlap = 0, exact = true;
  const b = old.brickDimensions;
  for (let z = 0; z < b.z; z++) for (let y = 1; y < b.y; y++) for (let x = 0; x < b.x; x++) {
    const previous = oldPages[x + b.x * (y + b.y * z)];
    const next = nextPages[x + b.x * (y - 1 + b.y * z)];
    exact &&= previous === next;
    for (let cell = 0; cell < old.cellsPerBrick; cell++) {
      const address = ((previous - 1) * old.cellsPerBrick + cell) * 4;
      exact &&= before[address] === after[address]; overlap++;
    }
  }
  const previousProjection = gas.getPressureProjection();
  const coarse = new ParticleSpatialGrid({ bounds: gas.bounds.clone(), ...options,
    minVolumeQuality: 8, maxVolumeQuality: 8 });
  gas.bounds.copy(coarse.bounds);
  gas.boundsMinNode.value.copy(gas.bounds.min);
  gas.ensureGridResolution(renderer, coarse);
  const context = { buffers, system, deltaTimeNode: float(1 / 60) };
  gas.volumeGrid.rebuild(context, renderer, gas.densityCurrent, gas.velocityCurrent,
    gas.boundsMinNode, gas.cellSizeNode, gas.densityCutoffNode, undefined,
    gas.pendingPreviousBounds, 3, gas.pendingPreviousGrid);
  gas.remapFields(renderer);
  const remapped = await read(gas.densityCurrent.value);
  const remapPreserved = remapped.some(value => value > 0) && remapped.every(Number.isFinite);
  const pressureInvalidated = gas.getPressureProjection() !== previousProjection;
  gas.solveProjection(renderer, gas.velocityCurrent, gas.velocityNext);
  const velocity = await read(gas.velocityNextAttribute);
  return { occupied: occupied.min.toArray().concat(occupied.max.toArray()),
    dimensions: gas.gridDimensions.toArray(), cellSize: gas.cellSize,
    queries, sourceError, cachedStencilError, liquidStencilError, emptyCutoffReleased,
    gasSupportPreserved, gasOnlyGuardRestored, remapPreserved, pressureInvalidated, overlap, exact,
    finite: velocity.every(Number.isFinite) };
};
window.ready = true;

// Bounded, opt-in layout benchmark shared by old/new build comparisons.
window.benchmarkDomainLayout = async () => {
  const particleGrid = new ParticleSpatialGrid({ brickSubdivisions: 2, cellSubdivisions: 3,
    cubicBounds: true, centeredAtOrigin: true, autoExpand: false });
  const target = new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 16, 1));
  particleGrid.setBounds(target);
  const start = performance.now();
  for (let i = 0; i < 4; i++) {
    particleGrid.rebuild(renderer, buffers, {});
    await renderer.resolveTimestampsAsync('compute');
  }
  const timings = [];
  for (let i = 0; i < 4; i++) {
    particleGrid.rebuild(renderer, buffers, {});
    timings.push(await renderer.resolveTimestampsAsync('compute'));
  }
  const size = particleGrid.bounds.getSize(new THREE.Vector3());
  const dimensions = particleGrid.gridDimensions?.toArray() ?? [32, 32, 32];
  return { kind: 'vertical-plume/generic-grid', size: size.toArray(), dimensions,
    volume: size.x * size.y * size.z, cellSize: particleGrid.cellSize || Math.max(...size.toArray()) / 32,
    qualitySide: particleGrid.volumeQualityTier ?? Math.max(...size.toArray()),
    gpuMs: timings.sort((a, b) => a - b)[2], fencedMs: performance.now() - start,
    reservedBytes: particleGrid.allocatedBytes ?? null };
};

// Small, independent boundary estimator fixture; no evolving demo or performance measurement.
window.checkAdaptiveGuards = async () => {
  const helper = new FluidGuardPrediction();
  const source = { key: buffers, compute: callback => Fn(() => callback(instanceIndex))().compute(2),
    sample: index => {
      const p = buffers.storage.createParticle(index, true);
      return { position: p.position, velocity: p.velocity.mul(p.speed),
        remainingLifetime: p.lifetime.sub(p.realtime.div(1000)), active: p.alive.notEqual(0) };
    } };
  const set = (slow, fast, lifetime = 10) => renderer.compute(Fn(() => {
    const p = buffers.storage.createParticle(undefined, true);
    p.alive.assign(1); p.position.assign(vec3(0, 0.9, 0));
    p.velocity.assign(vec3(0, instanceIndex.equal(0).select(slow, fast), 0));
    p.speed.assign(1); p.lifetime.assign(lifetime); p.realtime.assign(0);
    buffers.storage.storeParticle(p);
  })().compute(2));
  const support = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  set(0.1, 0.1);
  const slow = await helper.read(renderer, support, 0.25, [source]);
  set(4, 4);
  const fast = await helper.read(renderer, support, 0.25, [source]);
  set(0.1, 20);
  const outlier = await helper.read(renderer, support, 0.25, [source]);
  set(20, 20, 0.01);
  const dying = await helper.read(renderer, support, 0.25, [source]);
  helper.dispose();
  return { slow, fast, outlier, dying };
};

window.checkLiquidGuard = async () => {
  const liquid = new FLIPSimulation({ externalForce: new THREE.Vector3(), pressureIterations: 2,
    adaptiveTimestep: false, spatialGridOptions: { brickSubdivisions: 1, cellSubdivisions: 2,
      maxBounds: 8, minVolumeQuality: 2, maxVolumeQuality: 2 } });
  const root = new ParticleSystem({ gpuProcessing: true, maxParticles: 4, gravity: new THREE.Vector3(),
    emitters: new Emitter({ rate: 0, bursts: [{ time: 0, count: 4 }], initialValues: {
      velocity: new THREE.Vector3(0, 10, 0), speed: 1, lifetime: 0.5, scale: new THREE.Vector3(0.25, 0.25, 0.25),
    } }), modules: liquid, renderers: [] });
  scene.add(root);
  await renderer.renderAsync(scene, new THREE.PerspectiveCamera());
  root.advanceFrames(4, 1 / 60);
  await renderer.backend.device.queue.onSubmittedWorkDone();
  for (let i = 0; liquid.boundsReadPending && i < 1000; i++) {
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  const faces = liquid.guardDiagnostics.faces;
  root.destroy(); scene.remove(root);
  return faces;
};
