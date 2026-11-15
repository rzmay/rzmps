import * as THREE from 'three';
import { WebGPURenderer, StorageBufferAttribute } from 'three/webgpu';
import { Fn, instanceIndex, uniform, vec3, vec4 } from 'three/tsl';
import { ParticleSystem, GasSimulation, SpatialEffect, ParticleForceField, GasAffector, KillZone } from '@rzmps/rzmps';

const renderer = new WebGPURenderer();
renderer.setSize(256, 256);
document.body.append(renderer.domElement);
await renderer.init();
const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
camera.position.set(0, 0, 8);
const gas = new GasSimulation({
  bounds: new THREE.Box3(new THREE.Vector3(-2, -2, -2), new THREE.Vector3(2, 2, 2)),
  boundsPadding: 0, automaticPadding: false, adaptiveTimestep: false,
  spatialGridOptions: { brickSubdivisions: 1, cellSubdivisions: 2 },
  initialBrickCapacity: 8, maxActiveBricks: 8, pressureIterations: 0, maxVelocity: 100,
  externalForce: new THREE.Vector3(), buoyancy: 0, weight: 0, sourceStrength: 0,
  densityDissipation: 0, temperatureDissipation: 0, colorDissipation: 0, velocityDissipation: 0,
});
const system = new ParticleSystem({
  gpuProcessing: true, maxParticles: 1, emitters: [], modules: [gas], renderers: [],
});
scene.add(system);
await renderer.renderAsync(scene, camera);
system.advanceFrames(1, 1 / 60);
const grid = gas.spatialGrid;
const context = {
  system, buffers: system.gpuSimulation._gpuBuffers, deltaTime: 0.1, deltaTimeNode: uniform(0.1),
  elapsedTimeNode: uniform(0), gravityNode: vec3(0),
  simulationToWorldNode: uniform(new THREE.Matrix4()), worldToSimulationNode: uniform(new THREE.Matrix4()),
};
const read = async attribute => new Float32Array(await renderer.getArrayBufferAsync(attribute));
const address = 7 * 64; // Cell (4,4,4), center (0.25,0.25,0.25), in the final brick.
function seed() {
  renderer.compute(Fn(() => {
    gas.volumeGrid.pages.element(instanceIndex).assign(instanceIndex.add(1));
    gas.volumeGrid.slots.element(instanceIndex).assign(instanceIndex.add(1));
  })().compute(8));
  gas.volumeGrid.updateDispatch(renderer);
  renderer.compute(gas.computeCells(index => {
    gas.densityCurrent.element(index).assign(vec4(1, 2, 0, 0));
    gas.colorCurrent.element(index).assign(vec4(0.8, 0.4, 0.2, 0));
    gas.velocityCurrent.element(index).assign(vec4(0));
    gas.solid.element(index).assign(0);
    gas.faceOpenness.element(index).assign(vec4(1));
  }));
  renderer.compute(gas.computeCells(index => {
    gas.densityNext.element(index).assign(vec4(1, 2, 0, 0));
    gas.colorNext.element(index).assign(vec4(0.8, 0.4, 0.2, 0));
    gas.velocityNext.element(index).assign(vec4(0));
  }));
}
function select(effects) {
  gas.requireSpatialEffects = [GasAffector, ...effects];
  gas.explicitSpatialEffects = effects;
  gas.prepare(gas.beginExecution(system, 0.1));
  system.gpuSimulation._prepareGPUTagRegistry([gas], effects);
}
function apply(phase) {
  gas.applySpatialEffects(phase, gas.densityCurrent, gas.colorCurrent,
    phase === 'velocity' ? gas.velocityNext : gas.velocityCurrent, context, renderer);
}
const at = (data, index = address) => [...data.slice(index * 4, index * 4 + 4)];
const shape = () => new THREE.SphereGeometry(1, 12, 8);
window.runGasAffectorChecks = async () => {
  // Explicit native requirements remain supported alongside the discovery convenience flags.
  const discovered = ParticleForceField.Sphere({ direction: new THREE.Vector3(2, 0, 0) }, 1);
  const native = new GasAffector((cell, dt, _context, strength) => {
    cell.temperature.addAssign(cell.density.mul(dt).mul(strength).mul(10));
    cell.velocity.x.addAssign(cell.temperature.mul(dt).mul(strength));
    cell.density.mulAssign(0.5);
    cell.color.assign(vec3(0.2, 0.4, 0.6));
  }, { geometry: shape() });
  scene.add(discovered, native);
  gas.explicitSpatialEffects = undefined;
  gas.requireSpatialEffects = [GasAffector];
  gas.prepare(gas.beginExecution(system, 0.1));
  seed(); apply('velocity');
  const nativeVelocity = at(await read(gas.velocityNextAttribute));
  const automaticallyDiscovered = gas.spatialEffects.includes(native) && !gas.spatialEffects.includes(discovered);
  seed(); apply('scalars');
  const nativeState = {
    density: at(await read(gas.densityCurrent.value)), color: at(await read(gas.colorCurrent.value)),
  };
  native.priority = 1;
  gas.prepare(gas.beginExecution(system, 0.1));
  seed(); gas.renderGPU(context, context.buffers, renderer, grid);
  const nativeVisual = at(await read(gas.visualAttribute));
  const nativePersistent = at(await read(gas.densityCurrent.value));
  gas.requireSpatialEffects = [];
  gas.prepare(gas.beginExecution(system, 0.1));
  seed(); apply('velocity');
  const excludedVelocity = at(await read(gas.velocityNextAttribute));
  gas.supportForceFields = true;
  gas.prepare(gas.beginExecution(system, 0.1));
  seed(); apply('velocity');
  const enabledVelocity = at(await read(gas.velocityNextAttribute));
  gas.supportForceFields = false;
  gas.prepare(gas.beginExecution(system, 0.1));
  seed(); apply('velocity');
  const disabledVelocity = at(await read(gas.velocityNextAttribute));
  scene.remove(discovered, native);

  const force = new ParticleForceField({ geometry: shape(), direction: new THREE.Vector3(2, 0, 0) });
  select([force]); seed(); apply('velocity');
  const forceVelocity = at(await read(gas.velocityNextAttribute));
  seed();
  renderer.compute(gas.computeCells(index => {
    gas.densityCurrent.element(index).assign(vec4(0.0001, 0.0002, 0, 0));
  }));
  apply('velocity');
  const thinForceVelocity = at(await read(gas.velocityNextAttribute));
  const order = [], originalApply = gas.applySpatialEffects, originalProject = gas.solveProjection;
  gas.applySpatialEffects = function (...args) { order.push(args[0]); return originalApply.apply(this, args); };
  gas.solveProjection = function (...args) { order.push('projection'); return originalProject.apply(this, args); };
  seed(); gas.computeTransport(context, renderer, grid);
  gas.applySpatialEffects = originalApply; gas.solveProjection = originalProject;


  const generic = new SpatialEffect(null, { geometry: shape(), priority: -1, modifyGPU(p, dt) {
    p.velocity.x.addAssign(dt.mul(2)); p.color.mulAssign(0.5); p.alpha.mulAssign(0.5);
    p.position.addAssign(vec3(100)); p.scale.mulAssign(4); // Unsupported gas deltas stay local.
  } });
  scene.add(generic, discovered);
  gas.explicitSpatialEffects = undefined;
  gas.requireSpatialEffects = [];
  gas.supportForceFields = true;
  gas.prepare(gas.beginExecution(system, 0.1));
  seed(); apply('velocity');
  const subsetVelocity = at(await read(gas.velocityNextAttribute));
  gas.supportSpatialEffects = true;
  gas.supportForceFields = false;
  gas.prepare(gas.beginExecution(system, 0.1));
  seed(); apply('velocity');
  const broadVelocity = at(await read(gas.velocityNextAttribute));
  seed(); apply('scalars');
  const broadDensity = at(await read(gas.densityCurrent.value));
  generic.priority = 1;
  gas.prepare(gas.beginExecution(system, 0.1));
  seed(); gas.renderGPU(context, context.buffers, renderer, grid);
  const broadVisual = at(await read(gas.visualAttribute));
  const broadPersistent = at(await read(gas.densityCurrent.value));
  gas.supportSpatialEffects = false;
  gas.prepare(gas.beginExecution(system, 0.1));
  seed(); apply('velocity');
  const broadDisabled = at(await read(gas.velocityNextAttribute));
  scene.remove(generic, discovered);
  generic.priority = -1;

  select([generic]); seed(); apply('scalars');
  const persistent = { density: at(await read(gas.densityCurrent.value)),
    color: at(await read(gas.colorCurrent.value)) };
  select([]);
  gas.computeTransport(context, renderer, grid);
  const retained = at(await read(gas.densityCurrent.value));

  const heater = new GasAffector(null, { geometry: shape(), temperature: 10 });
  select([heater]); seed(); apply('scalars');
  const heated = at(await read(gas.densityCurrent.value));
  heater.temperature = 20;
  select([heater]); seed(); apply('scalars');
  const reheated = at(await read(gas.densityCurrent.value));
  heater.position.set(10, 0, 0); heater.syncGPUTransform(system);
  seed(); apply('scalars');
  const moved = at(await read(gas.densityCurrent.value));
  gas.tags = ['smoke'];
  const excluded = new GasAffector(null, { geometry: shape(), temperature: 10, tags: ['water'] });
  select([excluded]); seed(); apply('scalars');
  const tagged = at(await read(gas.densityCurrent.value));
  gas.tags = undefined;
  const local = new GasAffector(null, { geometry: shape(), density: 2, temperature: -10,
    color: '#00ff00', colorRate: 10, drag: 1 });
  select([local]); seed(); apply('scalars');
  const sourced = { density: at(await read(gas.densityCurrent.value)),
    color: at(await read(gas.colorCurrent.value)) };
  renderer.compute(gas.computeCells(index => { gas.velocityNext.element(index).assign(vec4(2, 0, 0, 0)); }));
  apply('velocity');
  const dragged = at(await read(gas.velocityNextAttribute));
  select([new GasAffector(null, { geometry: shape(), densityMultiplier: 0.5 })]); seed();
  context.deltaTimeNode.value = 1; apply('scalars');
  const multiplied = at(await read(gas.densityCurrent.value));
  context.deltaTimeNode.value = 0.1;
  const inverted = new GasAffector(null, { geometry: shape(), temperature: 10, inverted: true });
  select([inverted]); seed(); apply('scalars');
  const invertedCenter = at(await read(gas.densityCurrent.value));


  select([new KillZone({ geometry: shape() })]); seed(); apply('scalars');
  const killed = { density: at(await read(gas.densityCurrent.value)), color: at(await read(gas.colorCurrent.value)) };

  const visual = new SpatialEffect(null, { geometry: shape(), priority: 1, modifyGPU(p) {
    p.color.assign(vec3(0, 1, 0)); p.alpha.mulAssign(0.25); p.velocity.assign(vec3(2, 0, 0));
  } });
  select([visual, new GasAffector(null, { geometry: shape(), temperature: 10, priority: 1 })]); seed();
  gas.renderGPU(context, context.buffers, renderer, grid);
  const transient = { persistent: at(await read(gas.densityCurrent.value)),
    density: at(await read(gas.visualAttribute)),
    color: at(await read(gas.visualAttribute), gas.cellCount + address) };
  gas.renderGPU(context, context.buffers, renderer, grid);
  transient.repeated = at(await read(gas.visualAttribute));

  generic.feather = 1; generic.syncGPUTransform(system);
  const output = new StorageBufferAttribute(new Float32Array(4), 4);
  const result = (await import('three/tsl')).storage(output, 'vec4', 1);
  const sample = Fn(() => {
    const delta = generic.sampleDeltasGPU(vec3(1.5, 0, 0), {}, context.deltaTimeNode, context);
    result.element(0).assign(vec4(delta.velocity.x, delta.color.x, delta.alpha, delta.killed.select(1, 0)));
  })().compute(1);
  renderer.compute(sample);
  const feather = [...await read(output)];
  generic.position.set(10, 0, 0); generic.syncGPUTransform(system); renderer.compute(sample);
  const transformed = [...await read(output)];
  output.dispose();

  // Warm first-use graphs before timing only the effect dispatches at the same active-cell count.
  const benchmark = [];
  for (const count of [0, 1, 3]) {
    const effects = Array.from({ length: count }, () => new GasAffector(null, { geometry: shape(), drag: 0.5 }));
    select(effects); seed(); apply('velocity');
    await renderer.backend.device.queue.onSubmittedWorkDone();
    const originalCompute = renderer.compute;
    let dispatches = 0;
    renderer.compute = function (...args) { dispatches++; return originalCompute.apply(this, args); };
    const start = performance.now();
    try {
      for (let frame = 0; frame < 20; frame++) apply('velocity');
      await renderer.backend.device.queue.onSubmittedWorkDone();
    } finally { renderer.compute = originalCompute; }
    benchmark.push({ count, cells: 512, dispatches, milliseconds: performance.now() - start });
  }
  return { nativeVelocity, nativeState, nativeVisual, nativePersistent,
    subsetVelocity, broadVelocity, broadDensity, broadVisual, broadPersistent, broadDisabled,
    automaticallyDiscovered, excludedVelocity, enabledVelocity, disabledVelocity,
    forceVelocity, thinForceVelocity, order, persistent, retained, heated, reheated, moved,
    tagged, sourced, dragged,
    multiplied, invertedCenter, killed, transient, feather, transformed, benchmark };
};

// No sources or explicit dissipation. Open boundaries and interpolation can still lose transported smoke.
window.checkForceTransport = async () => {
  const force = ParticleForceField.Box({ direction: new THREE.Vector3(2, 0, 0) }, 20, 20, 20);
  select([force]);
  seed();
  gas.pressureIterations = 32;
  gas.scalarDiffusion = 0;
  context.deltaTimeNode.value = 1 / 60;
  renderer.compute(gas.computeCells(index => {
    const c = gas.cellCoordinate(index);
    const inside = c.greaterThanEqual(vec3(2)).all().and(c.lessThan(vec3(6)).all());
    gas.densityCurrent.element(index).assign(inside.select(vec4(1, 2, 0, 0), vec4(0)));
    gas.colorCurrent.element(index).assign(inside.select(vec4(1, 1, 1, 0), vec4(0)));
  }));
  const mass = async () => {
    const data = await read(gas.densityCurrent.value);
    return data.reduce((sum, value, index) => sum + (index % 4 === 0 ? value : 0), 0);
  };
  const initial = await mass();
  const samples = [initial];
  for (let frame = 0; frame < 30; frame++) {
    gas.computeTransport(context, renderer, grid);
    if (frame % 5 === 4) samples.push(await mass());
  }
  return { initial, samples };
};
window.ready = true;
