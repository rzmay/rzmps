/* eslint-env node */
import assert from 'node:assert/strict';
import { GasSimulation, PressureSolver } from '../../build/index.mjs';

const make = options => new GasSimulation({ spatialGridOptions: { brickSubdivisions: 0, cellSubdivisions: 1 },
  ...options });
for (const [options, expected] of [
  [{}, PressureSolver.Auto],
  [{ pressureIterations: 16 }, PressureSolver.Auto],
  [{ multigrid: {} }, PressureSolver.Multigrid],
  [{ multigrid: { preSmoothing: 2, postSmoothing: 4 } }, PressureSolver.Multigrid],
  [{ multigrid: {}, pressureSolver: PressureSolver.Auto }, PressureSolver.Auto],
  [{ multigrid: { bottomIterations: -1 }, pressureSolver: 'Iterative' }, PressureSolver.Iterative],
  [{ pressureSolver: 'Multigrid' }, PressureSolver.Multigrid],
]) {
  const gas = make(options);
  assert.equal(gas.pressureSolver, expected);
  assert.equal(gas.multigrid, options.multigrid);
  gas.cleanup();
}
assert.deepEqual(Object.keys(PressureSolver), ['Auto', 'Iterative', 'Multigrid']);
console.log('Pressure solver defaults, enum strings and explicit precedence passed.');

const auto = make({ pressureSolver: PressureSolver.Auto });
assert.equal(auto.pressureSelection(), PressureSolver.Iterative);
auto.gridDimensions.set(128, 128, 128);
auto.brickDiagnostics.resident = Math.ceil(2_500_000 / auto.volumeGrid.cellsPerBrick);
auto.pressureIterations = 64; auto.pressureMinIterations = 0; auto.pressureTolerance = 0.1;
assert.equal(auto.pressureSelection(), PressureSolver.Multigrid);
auto.pressureTolerance = 0;
assert.equal(auto.pressureSelection(), PressureSolver.Iterative);
auto.pressureTolerance = 0.1; auto.pressureMinIterations = 64;
assert.equal(auto.pressureSelection(), PressureSolver.Iterative);
auto.cleanup();

// Boundary geometry generations must not follow RHS-only wall velocity or a world-space emitter root.
const { ParticleSystem, SimulationSpace } = await import('../../build/index.mjs');
const { uniform } = await import('three/tsl');
const boundary = make({});
Object.defineProperty(boundary, 'fluidColliders', { get: () => [] });
const system = new ParticleSystem({ emitters: [], modules: [], renderers: [], simulationSpace: SimulationSpace.World });
const context = { system, deltaTimeNode: uniform(1 / 60) };
const renderer = { compute() {} };
boundary.computeSolidField(context, renderer);
const generation = boundary.pressureTopologyVersion;
boundary.boundaryWasMoving = true;
boundary.computeSolidField(context, renderer);
assert.equal(boundary.pressureTopologyVersion, generation, 'Clearing wall velocity changed the operator generation');
system.position.x = 2; system.updateMatrixWorld(true);
boundary.computeSolidField(context, renderer);
assert.equal(boundary.pressureTopologyVersion, generation, 'World-space source motion changed the operator generation');
boundary.cleanup(); system.dispose();
