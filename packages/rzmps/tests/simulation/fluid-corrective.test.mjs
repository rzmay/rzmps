/* eslint-env node */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Module, ParticleSystem, FLIPSimulation, GasSimulation, VolumeRenderer } from '../../build/index.mjs';

const gas = new GasSimulation({ maxBrickCapacity: 128 });
assert.equal(gas.volumeGrid.capacity, 1, 'unprepared automatic pools only hold bootstrap storage');
assert.equal(gas.maxBrickCapacity, 128);
assert.equal(gas.pressureSolver, 'Auto');
assert.equal(gas.pressureWarmStart, true);
assert.equal(gas.pressureTolerance, 0);
assert.equal(gas.pressureControls.minIterations, gas.pressureIterations);
gas.pressureIterations = 20;
assert.equal(gas.pressureControls.maxIterations, 20, 'legacy sweep control must remain editable');
gas.pressureMinIterations = 2;
gas.pressureMaxIterations = 32;
assert.equal(gas.pressureControls.minIterations, 2);
assert.equal(gas.pressureControls.maxIterations, 32);
const managedOwner = new ParticleSystem({ emitters: [], renderers: [] });
const managed = gas.getParticleSpatialGrid(managedOwner);
const retainedVelocity = gas.velocityCurrentAttribute;
gas.maxBrickCapacity = 256;
gas.ensureGridResolution({ compute() {} }, managed);
assert.equal(gas.velocityCurrentAttribute, retainedVelocity, 'raising the pool limit must not reset valid fields');
const flip = new FLIPSimulation({ adaptiveTimestep: true, cfl: 1, maxFluidSubsteps: 4, maxVelocity: 40 });
const request = 1 / 15;
const step = flip.getSimulationTimestep(request);
assert(step > 0 && step <= request);
assert.equal(flip.getSimulationSubstepLimit(), 4);
flip.adaptiveTimestep = false;
assert.equal(flip.getSimulationTimestep(request), Infinity);
flip.adaptiveTimestep = true;
flip.cfl = 0;
assert.throws(() => flip.getSimulationTimestep(request), /CFL/);
for (const options of [{ initialBrickCapacity: 0 }, { initialBrickCapacity: 32, maxBrickCapacity: 16 },
  { maxBrickCapacity: Infinity }]) assert.throws(() => new GasSimulation(options), /capacities/);
assert.equal(new GasSimulation({ maxBrickCapacity: 4 }).volumeGrid.capacity, 1);

// A long browser frame must not multiply the fluid budget through the system's
// smaller configured step. Non-fluid modules retain their ordinary catch-up path.
const limiter = new Module(() => {});
limiter.getSimulationTimestep = () => 1 / 120;
limiter.getSimulationSubstepLimit = () => 4;
const limited = new ParticleSystem({ emitters: [], renderers: [], modules: limiter,
  substepDeltaTime: 1 / 240, maxCatchup: 10 });
const executed = [];
limited._advanceSimulationStep = () => executed.push(limited.deltaTime);
limited.advanceFrames(1, 2);
assert.equal(executed.length, 4, 'the module limit bounds the actual system loop');
assert(executed.every(dt => dt <= 1 / 240));
limited.destroy();

const system = new ParticleSystem({ emitters: [], renderers: [] });
let prepared = 0;
let rendererPrepared = 0;
let finishRendererPreparation;
const rendererPreparation = new Promise(resolve => { finishRendererPreparation = resolve; });
const volume = new VolumeRenderer();
volume.prepareResources = async owner => {
  assert.equal(owner, system);
  rendererPrepared++;
  await rendererPreparation;
};
system.addRenderer(volume);
const module = new Module(() => { throw new Error('Preparation must not call modify'); });
module.prepareResources = async owner => {
  assert.equal(owner, system);
  assert.equal(rendererPrepared, 1, 'renderer preparation starts alongside module preparation');
  prepared++;
  finishRendererPreparation();
};
module.prepare = () => { throw new Error('Preparation must not call per-step prepare'); };
system.modules = [module];
const before = { time: system._elapsedTime, particles: system.liveParticleCount };
await system.prepare({ isWebGPURenderer: true });
assert.equal(prepared, 1);
assert.equal(rendererPrepared, 1);
assert.deepEqual({ time: system._elapsedTime, particles: system.liveParticleCount }, before);
await assert.rejects(system.prepare({}), /WebGPU/);
system.destroy();
flip.cleanup();
gas.cleanup();
managedOwner.destroy();
console.log('Fluid pressure controls, sparse reservation, CFL and non-advancing preparation passed.');
