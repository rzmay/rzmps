import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { Fn, float, instanceIndex, vec4 } from 'three/tsl';
import { GasSimulation } from '@rzmps/rzmps';
const renderer = new WebGPURenderer({ trackTimestamp: true });
await renderer.init();

// Normalize all snapshots into logical coordinates: pool slot permutations must not affect a solve.
async function logical(grid, attribute, channels) {
  const buffer = renderer.getArrayBufferAsync(attribute);
  const pages = new Uint32Array(await renderer.getArrayBufferAsync(grid.pagesAttribute));
  const data = new Float32Array(await buffer),
    dimensions = grid.gridDimensions,
    n = dimensions.x,
    b = grid.brickSide;
  const result = new Float32Array(n * dimensions.y * dimensions.z * channels);
  for (let z = 0; z < dimensions.z; z++)
    for (let y = 0; y < dimensions.y; y++)
      for (let x = 0; x < n; x++) {
        const side = grid.brickDimensions;
        const page = pages[Math.floor(x / b) + side.x * (Math.floor(y / b) + side.y * Math.floor(z / b))];
        if (!page) continue;
        const address = (page - 1) * grid.cellsPerBrick + (x % b) + b * ((y % b) + b * (z % b));
        result.set(data.subarray(address * channels, (address + 1) * channels),
          (x + n * (y + dimensions.y * z)) * channels);
      }
  return [...result];
}
function activate(gas, order) {
  const g = gas.volumeGrid;
  renderer.compute(Fn(() => g.pages.element(instanceIndex).assign(0))().compute(g.brickCount));
  renderer.compute(Fn(() => g.slots.element(instanceIndex).assign(0))().compute(g.capacity));
  order.forEach((brick, slot) =>
    renderer.compute(
      Fn(() => {
        g.pages.element(brick).assign(slot + 1);
        g.slots.element(slot).assign(brick + 1);
      })().compute(1),
    ),
  );
  g.updateDispatch(renderer);
}
function seed(gas, warm, initial = false) {
  renderer.compute(
    gas.computeCells(index => {
      const c = gas.cellCoordinate(index);
      const old = c.x.lessThan(8);
      const velocity = float(c.x).add(0.5).mul(0.4).sin();
      gas.velocityNext.element(index).assign(vec4(initial ? old.select(velocity, 0) : velocity, 0, 0, 0));
      gas.solid.element(index).assign(0);
      gas.faceOpenness.element(index).assign(vec4(1));
      gas.solidVelocity.element(index).assign(vec4(0));
      gas.pressureCurrent.element(index).assign(warm ? float(c.y).mul(0.001) : 0);
    }),
  );
}
window.transition = async (warm, rectangular = false, removed = false) => {
  const all = [0, 1, 2, 3];
  const branches = [];
  for (const incremental of [true, false]) {
    const gas = new GasSimulation({
      bounds: new THREE.Box3(new THREE.Vector3(-1, rectangular ? -2 : -1, -1),
        new THREE.Vector3(1, rectangular ? 2 : 1, 1)),
      automaticPadding: false,
      boundsPadding: 0,
      spatialGridOptions: rectangular ? { brickSubdivisions: 2, cellSubdivisions: 2 }
        : { brickSubdivisions: 1, cellSubdivisions: 3 },
      initialBrickCapacity: 8,
      maxBrickCapacity: 8,
      pressureSolver: 'Multigrid',
      pressureWarmStart: warm,
      pressureIterations: 8,
      maxVelocity: 100,
    });
    activate(gas, removed ? incremental ? all : [0, 2] : incremental ? [0, 2] : all);
    seed(gas, warm, true);
    gas.solveProjection(renderer, gas.velocityNext, gas.velocityCurrent);
    await renderer.backend.device.queue.onSubmittedWorkDone();
    activate(gas, removed ? [0, 2] : incremental ? [0, 2, 1, 3] : all);
    seed(gas, warm);
    const grid = gas.volumeGrid;
    const inputs = await Promise.all(
      [gas.velocityNextAttribute, gas.pressureCurrentAttribute, gas.solidAttribute, gas.boundaryAttribute].map(
        (attribute, i) => logical(grid, attribute, i === 0 || i === 3 ? 4 : 1),
      ),
    );
    const projection = gas.getPressureProjection();
    const pending = [];
    const capture = (stage, level, g, attribute, channels) => {
      pending.push(logical(g, attribute, channels).then(values => ({ stage, level,
        n: g.gridDimensions.x, dimensions: g.gridDimensions.toArray(), values })));
    };
    for (const [index, level] of projection.multigrid.levels.entries()) {
      const residual = level.fine.updateResidual;
      level.fine.updateResidual = target => {
        residual.call(level.fine, target);
        capture(
          'residual',
          index,
          level.fine.grid,
          index === 0 ? projection.multigridResidualAttribute : projection.multigrid.levels[index - 1].valuesAttribute,
          index === 0 ? 1 : 4,
        );
      };
      for (const method of ['restrict', 'smooth', 'prolong']) {
        const original = level[method];
        level[method] = function (...args) {
          const result = original.apply(this, args);
          if (method === 'prolong')
            capture(
              'prolongation',
              index,
              level.fine.grid,
              index === 0 ? gas.pressureCurrentAttribute : projection.multigrid.levels[index - 1].valuesAttribute,
              index === 0 ? 1 : 4,
            );
          else {
            capture(method, index, level.grid, level.valuesAttribute, 4);
            if (method === 'restrict') capture('coefficients', index, level.grid, level.coefficientsAttribute, 4);
          }
          return result;
        };
      }
    }
    gas.solveProjection(renderer, gas.velocityNext, gas.velocityCurrent);
    capture('post-smoothing/final-pressure', 0, grid, gas.pressureCurrentAttribute, 1);
    capture('projected-velocity', 0, grid, gas.velocityCurrentAttribute, 4);
    const trace = await Promise.all(pending);
    branches.push({ inputs, trace });
    gas.dispose();
  }
  return branches;
};
window.ready = true;

window.pressureComparison = async () => {
  const measurements = [];
  for (const solver of ['Iterative', 'Multigrid']) {
    const gas = new GasSimulation({
      bounds: new THREE.Box3(new THREE.Vector3(-1, -2, -1), new THREE.Vector3(1, 2, 1)),
      spatialGridOptions: { brickSubdivisions: 2, cellSubdivisions: 2 },
      initialBrickCapacity: 64, maxBrickCapacity: 64, pressureSolver: solver,
      pressureIterations: solver === 'Iterative' ? 24 : 6, pressureWarmStart: false,
      pressureDiagnostics: true, adaptiveTimestep: false, maxVelocity: 100,
    });
    activate(gas, Array.from({ length: gas.volumeGrid.brickCount }, (_, i) => i));
    for (let i = 0; i < 3; i++) {
      seed(gas, false);
      gas.solveProjection(renderer, gas.velocityNext, gas.velocityCurrent);
      await renderer.resolveTimestampsAsync('compute');
    }
    const samples = [];
    for (let i = 0; i < 4; i++) {
      seed(gas, false);
      await renderer.resolveTimestampsAsync('compute');
      gas.solveProjection(renderer, gas.velocityNext, gas.velocityCurrent);
      samples.push(await renderer.resolveTimestampsAsync('compute'));
    }
    const diagnostics = await gas.getPressureProjection().readDiagnostics(renderer, gas.velocityCurrent);
    measurements.push({ solver, dimensions: gas.gridDimensions.toArray(),
      fineSweeps: gas.pressureIterations, pressureGPUms: samples.sort((a, b) => a - b)[2], diagnostics });
    gas.dispose();
  }
  return measurements;
};
