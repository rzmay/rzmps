import { Box3, Vector3 } from 'three';
import { WebGPURenderer, StorageBufferAttribute } from 'three/webgpu';
import { Fn, If, instanceIndex, storage, uint, uniform, vec3, vec4 } from 'three/tsl';
import SparseVolumeGrid from '../../../../../packages/rzmps/src/spatial/structures/gpu/SparseVolumeGrid.ts';
import FluidPressureProjection from '../../../../../packages/rzmps/src/simulation/gpu/FluidPressureProjection.ts';
import {
  pressureAutoPolicy, pressureHierarchy,
} from '../../../../../packages/rzmps/src/simulation/gpu/pressureSolver.utils.ts';
import { passTimer } from './volume-quality.js';

const renderer = new WebGPURenderer({ trackTimestamp: true });
await renderer.init();
const device = renderer.backend.device;
const fence = () => device.queue.onSubmittedWorkDone();
const assert = (test, message) => { if (!test) throw new Error(message); };

function fixture(dimensions, obstacle = false) {
  const shape = new Vector3(...dimensions), h = 2 / Math.max(...dimensions);
  const bounds = new Box3(new Vector3(), shape.clone().multiplyScalar(h));
  const grid = new SparseVolumeGrid({ bounds, brickSubdivisions: 3, cellSubdivisions: 3 },
    Math.ceil(shape.x / 8) * Math.ceil(shape.y / 8) * Math.ceil(shape.z / 8), shape);
  const attributes = [];
  const field = (channels = 1) => {
    const attribute = new StorageBufferAttribute(new Float32Array(grid.cellCount * channels), channels);
    attributes.push(attribute);
    return storage(attribute, channels === 1 ? 'float' : 'vec4', grid.cellCount);
  };
  const pressure = field(), divergence = field(), solid = field(), openness = field(4);
  const velocity = field(4), output = field(4), phase = uniform(0), spacing = uniform(h), wallEnabled = uniform(1);
  const closed = uniform(new Vector3());
  const controls = { minIterations: 0, maxIterations: 64, tolerance: 0, warmStart: false,
    diagnostics: false, report() {}, multigrid: false, topologyVersion: 0 };
  const projection = new FluidPressureProjection(shape, spacing, uniform(10000), solid, pressure,
    divergence, closed, closed, grid, undefined, undefined, undefined, openness, undefined, () => controls);
  const activate = Fn(() => {
    If(instanceIndex.lessThan(grid.brickCount), () => {
      grid.pages.element(instanceIndex).assign(instanceIndex.add(1));
      grid.slots.element(instanceIndex).assign(instanceIndex.add(1));
    });
  })().compute(grid.capacity);
  renderer.compute(activate); grid.updateDispatch(renderer);
  const seed = grid.compute(index => {
    const c = grid.coordinate(index), position = vec3(c).add(0.5).mul(h);
    const unit = position.div(vec3(shape).mul(h));
    const x = unit.x.mul(Math.PI), y = unit.y.mul(Math.PI), z = unit.z.mul(Math.PI);
    // Low-frequency error with a smaller high-frequency component; no random particle inputs.
    velocity.element(index).assign(vec4(x.sin().mul(y.sin()).mul(z.sin())
      .add(x.mul(9).sin().mul(0.05)), y.mul(2).sin().mul(0.3), z.sin().mul(0.2), 0));
    pressure.element(index).assign(0);
    solid.element(index).assign(0);
    if (obstacle) {
      const center = vec3(shape).mul(h * 0.5).add(vec3(phase.sin().mul(0.1), 0, 0));
      const face = (axis) => {
        const offset = axis === 0 ? vec3(0.5, 0, 0) : axis === 1 ? vec3(0, 0.5, 0) : vec3(0, 0, 0.5);
        return position.sub(offset.mul(h)).sub(center).length().sub(0.27).div(h).add(0.5).clamp(0, 1);
      };
      const fluid = position.sub(center).length().greaterThan(0.27);
      openness.element(index).assign(wallEnabled.greaterThan(0)
        .select(vec4(face(0), face(1), face(2), fluid.select(1, 0)), vec4(1)));
    } else openness.element(index).assign(vec4(1));
  });
  return { grid, projection, velocity, output, controls, seed, phase, pressure, spacing, wallEnabled, h,
    dispose() { projection.dispose(); seed.dispose(); activate.dispose(); attributes.forEach(a => a.dispose());
      grid.dispose(renderer); } };
}

window.runConvergence = async ({ dimensions = [64, 64, 64], obstacle = false,
  referenceIterations = 16, crossoverOnly = false } = {}) => {
  const f = fixture(dimensions, obstacle), results = [], traces = [];
  let stage = 'pressure';
  const timer = passTimer(device, renderer.backend, () => stage);
  f.controls.stage = (name, operation) => { const before = stage; stage = name; operation(); stage = before; };
  const solve = () => f.projection.solve(renderer, f.velocity, f.output, f.controls.maxIterations);
  let configs = [{ name: `Iterative${referenceIterations}`, multigrid: false, budget: referenceIterations },
    ...[[2, 4, 12], [2, 6, 12], [1, 3, 12], [2, 4, 24]].flatMap(([preSmooth, postSmooth, coarseIterations]) =>
      [8, 16, 24].map(budget => ({ name: `MG-${preSmooth}-${postSmooth}-${coarseIterations}-${budget}`,
        multigrid: true, budget, preSmooth, postSmooth, coarseIterations })))];

  if (crossoverOnly) configs = [configs[0], { name: 'MG-global', multigrid: true,
    budget: referenceIterations, preSmooth: 2, postSmooth: 4, coarseIterations: 12 },
    { name: 'Auto', auto: true, multigrid: referenceIterations >= pressureAutoPolicy.minimumWork
      && f.grid.capacity * f.grid.cellsPerBrick >= pressureAutoPolicy.entryCells
      && pressureHierarchy(dimensions).usefulLevels >= pressureAutoPolicy.minimumLevels,
    budget: referenceIterations, preSmooth: 2, postSmooth: 4, coarseIterations: 12 }];

  try {
    let target;
    for (const config of configs) {
      Object.assign(f.controls, { multigrid: config.multigrid, autoMultigrid: Boolean(config.auto),
        maxIterations: config.budget,
        tolerance: target ?? 0, multigridOptions: config });
      // Warm every graph before timing; reseed the same RHS and zero fine pressure each time.
      for (let i = 0; i < (config.auto ? 10 : 2); i++) { renderer.compute(f.seed); solve(); await fence(); }
      const samples = [];
      for (let i = 0; i < 3; i++) {
        renderer.compute(f.seed); await fence(); timer.start();
        const start = performance.now(); solve(); await fence();
        const wallMs = performance.now() - start;
        const timing = await timer.finish();
        samples.push({ wallMs, gpuMs: timing.computeGPUms, stages: timing.stageGPUms });
      }
      const stats = await f.projection.readDiagnostics(renderer, f.output);
      if (target === undefined) target = maxNumber(stats.pressureResidual, 1e-6);
      assert(stats.nonFiniteSamples === 0, 'Non-finite pressure result');
      results.push({ ...config, selectedMG: new Float32Array(await renderer.getArrayBufferAsync(
        f.projection.convergenceAttribute))[3], target, stats, samples,
        equalQuality: stats.pressureResidual <= target * 1.05
          && stats.maxDivergenceAfterProjection <= (results[0]?.stats ?? stats).maxDivergenceAfterProjection * 1.05
          && stats.meanDivergenceAfterProjection
            <= (results[0]?.stats ?? stats).meanDivergenceAfterProjection * 1.05 });
    }
    // Capture phase progression separately: diagnostic readbacks never contaminate timing.
    const best = results.filter(r => r.multigrid && r.equalQuality)
      .sort((a, b) => median(a.samples.map(s => s.gpuMs)) - median(b.samples.map(s => s.gpuMs)))[0]
      ?? results.at(-1);
    Object.assign(f.controls, { multigrid: true, autoMultigrid: false,
      maxIterations: best.budget, tolerance: 0,
      multigridOptions: best });
    const pending = [];
    f.controls.trace = (name, level) => {
      if (!level) pending.push(f.projection.readDiagnostics(renderer, f.output).then(stats => ({ name, ...stats })));
      else {
        level.updateResidual(renderer);
        pending.push(Promise.all([renderer.getArrayBufferAsync(level.valuesAttribute),
          renderer.getArrayBufferAsync(level.grid.pagesAttribute)]).then(([buffer, mapping]) => {
          const data = new Float32Array(buffer), pages = new Uint32Array(mapping);
          let residual = 0, rhs = 0, correctionMax = 0;
          for (let i = 0; i < data.length; i += 4) {
            const slot = Math.floor(i / 4 / level.grid.cellsPerBrick);
            if (!pages[level.grid.directoryCapacity + slot] || data[i + 2] <= 0) continue;
            correctionMax = Math.max(correctionMax, Math.abs(data[i]));
            residual = Math.max(residual, Math.abs(data[i + 3])); rhs = Math.max(rhs, Math.abs(data[i + 1]));
          }
          if (name === 'restriction') assert(correctionMax === 0, 'Coarse correction survived restriction');
          return { name, dimensions: level.grid.gridDimensions.toArray(), residual, rhs, correctionMax };
        }));
      }
    };
    renderer.compute(f.seed); solve(); traces.push(...await Promise.all(pending));
    return { dimensions, obstacle, h: f.h, residentPages: f.grid.capacity, results, traces };
  } finally { await fence(); timer.dispose(); f.dispose(); }
};
const maxNumber = (a, b) => Math.max(a, b);
const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
window.ready = true;

// Exercise actual GPU transfers, independently of velocity projection and convergence tuning.
window.transferTests = async () => {
  const results = [];
  for (const dimensions of [[32, 32, 32], [1, 32, 2]]) for (const obstacle of [false, true]) {
    const f = fixture(dimensions, obstacle);
    try {
      Object.assign(f.controls, { multigrid: true, maxIterations: 16 });
      renderer.compute(f.seed);
      f.projection.solve(renderer, f.velocity, f.output, 16);
      const level = f.projection.multigrid.levels[0];
      const fine = level.fine;
      // Restriction must preserve a constant RHS, including a singleton axis.
      const rhs = f.grid.compute(index => f.projection.multigridResidual.element(index).assign(1));
      const update = fine.updateResidual;
      fine.updateResidual = target => target.compute(rhs);
      level.restrict(renderer);
      const data = new Float32Array(await renderer.getArrayBufferAsync(level.valuesAttribute));
      const finePages = new Uint32Array(await renderer.getArrayBufferAsync(f.grid.pagesAttribute));
      const coarsePages = new Uint32Array(await renderer.getArrayBufferAsync(level.grid.pagesAttribute));
      const boundary = new Float32Array(await renderer.getArrayBufferAsync(f.projection.openness.value));
      const address = (grid, pages, x, y, z) => {
        const b = grid.brickSide, side = grid.brickDimensions;
        const page = pages[Math.floor(x / b) + side.x * (Math.floor(y / b) + side.y * Math.floor(z / b))];
        return (page - 1) * grid.cellsPerBrick + x % b + b * (y % b + b * (z % b));
      };
      const coarse = level.grid.gridDimensions, ratio = level.ratio.value;
      let restrictionError = 0;
      for (let z = 0; z < coarse.z; z++) for (let y = 0; y < coarse.y; y++) for (let x = 0; x < coarse.x; x++) {
        let fluidChildren = 0;
        for (let k = 0; k < ratio.z; k++) for (let j = 0; j < ratio.y; j++) for (let i = 0; i < ratio.x; i++) {
          const child = address(f.grid, finePages, x * ratio.x + i, y * ratio.y + j, z * ratio.z + k);
          if (boundary[child * 4 + 3] > 0) fluidChildren++;
        }
        const expected = fluidChildren / (ratio.x * ratio.y * ratio.z);
        restrictionError = Math.max(restrictionError,
          Math.abs(data[address(level.grid, coarsePages, x, y, z) * 4 + 1] - expected));
      }
      assert(restrictionError < 1e-6, 'Restriction failed the physical-volume average');
      fine.updateResidual = update;
      const closed = f.projection.closedMin;
      const closedMax = f.projection.closedMax;
      const n = level.grid.gridDimensions;
      const transfers = [];
      for (const kind of obstacle ? ['constant'] : ['constant', 'linear', 'lowFrequency']) {
        closed.value.set(1, kind === 'constant' ? 1 : 0, 1);
        closedMax.value.copy(closed.value);
        const seed = level.grid.compute(index => {
          const c = level.grid.coordinate(index);
          const y = vec3(c).y.add(0.5).div(n.y);
          level.values.element(index).x.assign(kind === 'constant' ? 1
            : kind === 'linear' ? y : y.mul(Math.PI).sin());
        });
        const clear = f.grid.compute(index => f.pressure.element(index).assign(0));
        renderer.compute(seed); renderer.compute(clear); level.prolong(renderer);
        const pressure = new Float32Array(await renderer.getArrayBufferAsync(f.pressure.value));
        const pages = new Uint32Array(await renderer.getArrayBufferAsync(f.grid.pagesAttribute));
        const boundary = new Float32Array(await renderer.getArrayBufferAsync(f.projection.openness.value));
        let error = 0;
        for (let z = 0; z < dimensions[2]; z++) for (let y = 0; y < dimensions[1]; y++) {
          for (let x = 0; x < dimensions[0]; x++) {
            // Linear interpolation is exact away from incompatible zero-pressure end faces.
            if (kind === 'linear' && (y < 2 || y >= dimensions[1] - 2)) continue;
            const b = f.grid.brickSide, side = f.grid.brickDimensions;
            const page = pages[Math.floor(x / b) + side.x * (Math.floor(y / b) + side.y * Math.floor(z / b))];
            const index = (page - 1) * f.grid.cellsPerBrick + x % b + b * (y % b + b * (z % b));
            if (boundary[index * 4 + 3] <= 0) continue;
            const expected = kind === 'constant' ? 1 : kind === 'linear' ? (y + 0.5) / dimensions[1]
              : Math.sin(Math.PI * (y + 0.5) / dimensions[1]);
            error = Math.max(error, Math.abs(pressure[index] - expected));
          }
        }
        assert(error < (kind === 'lowFrequency' ? 0.006 : 1e-6), `Transfer ${kind} error ${error}`);
        transfers.push({ kind, maxError: error });
        seed.dispose(); clear.dispose();
      }
      let faceAverageError = null;
      if (!obstacle) {
        closed.value.setScalar(0); closedMax.value.setScalar(0);
        const faces = f.grid.compute(index => {
          const y = f.grid.coordinate(index).y;
          f.projection.openness.element(index).assign(vec4(y.mod(2).equal(0).select(0.2, 0.6), 0.35, 0.75, 1));
        });
        renderer.compute(faces); f.projection.updateTopology();
        f.projection.solve(renderer, f.velocity, f.output, 16); level.restrict(renderer);
        const coefficients = new Float32Array(await renderer.getArrayBufferAsync(level.coefficientsAttribute));
        const values = new Float32Array(await renderer.getArrayBufferAsync(level.valuesAttribute));
        faceAverageError = 0;
        for (let i = 0; i < values.length; i += 4) {
          if (values[i + 2] <= 0) continue;
          faceAverageError = Math.max(faceAverageError, Math.abs(coefficients[i] - 0.4),
            Math.abs(coefficients[i + 1] - 0.35), Math.abs(coefficients[i + 2] - 0.75));
        }
        assert(faceAverageError < 1e-6, 'Coarse face openness lost its area average'); faces.dispose();
      }
      // Rebuilding and reusing the operator must give the same multiple-cycle correction.
      const mg = f.projection.multigrid, correct = mg.correct;
      Object.assign(f.controls, { maxIterations: 24, tolerance: 0, warmStart: false });
      mg.correct = function (renderer, options) { return correct.call(this, renderer, options, true); };
      renderer.compute(f.seed); f.projection.updateTopology();
      f.projection.solve(renderer, f.velocity, f.output, 24);
      const rebuilt = new Uint32Array(await renderer.getArrayBufferAsync(f.pressure.value));
      mg.correct = correct;
      renderer.compute(f.seed); f.projection.updateTopology();
      f.projection.solve(renderer, f.velocity, f.output, 24);
      const reused = new Uint32Array(await renderer.getArrayBufferAsync(f.pressure.value));
      assert(rebuilt.every((value, i) => value === reused[i]), 'Coarse operator reuse changed the solution');
      results.push({ dimensions, obstacle, restrictionError, transfers, faceAverageError, exactOperatorReuse: true });
      rhs.dispose();
    } finally { await fence(); f.dispose(); }
  }
  return results;
};

window.testTopologyReuse = async () => {
  const f = fixture([32, 32, 32], true), checks = [];
  Object.assign(f.controls, { multigrid: true, maxIterations: 16 });
  const solve = () => f.projection.solve(renderer, f.velocity, f.output, 16);
  const state = async () => {
    const buffer = new Float32Array(await renderer.getArrayBufferAsync(f.projection.convergenceAttribute));
    return { rebuilt: buffer[2], selectedMG: buffer[3] };
  };
  const cases = ['initial', 'rhs', 'movingCollider', 'removedCollider', 'recycledPage', 'translatedDomain', 'quality'];
  try {
    for (const name of cases) {
      if (name === 'movingCollider') { f.phase.value = 1; f.controls.topologyVersion++; }
      if (name === 'removedCollider') { f.wallEnabled.value = 0; f.controls.topologyVersion++; }
      if (name === 'recycledPage') {
        const last = f.grid.brickCount - 1;
        const swap = Fn(() => {
          f.grid.pages.element(0).assign(last + 1); f.grid.pages.element(last).assign(1);
          f.grid.slots.element(0).assign(last + 1); f.grid.slots.element(last).assign(1);
          f.grid.fresh.element(0).assign(1); f.grid.fresh.element(last).assign(1);
        })().compute(1);
        renderer.compute(swap); f.grid.updateDispatch(renderer); swap.dispose();
      }
      if (name === 'translatedDomain') {
        const bounds = f.grid.bounds.clone().translate(new Vector3(0.25, 0, 0));
        f.grid.setLayoutMetadata(bounds, f.grid.gridDimensions);
      }
      if (name === 'quality') {
        f.spacing.value *= 2;
        const bounds = f.grid.bounds.clone(); bounds.max.copy(bounds.min).addScalar(4);
        f.grid.setLayoutMetadata(bounds, f.grid.gridDimensions);
      }
      renderer.compute(f.seed);
      if (name === 'rhs') {
        const scale = f.grid.compute(index => f.velocity.element(index).mulAssign(0.75));
        renderer.compute(scale); scale.dispose();
      }
      solve();
      const flags = await state();
      const actual = new Float32Array(await renderer.getArrayBufferAsync(f.pressure.value));
      f.projection.updateTopology();
      renderer.compute(f.seed);
      if (name === 'rhs') {
        const scale = f.grid.compute(index => f.velocity.element(index).mulAssign(0.75));
        renderer.compute(scale); scale.dispose();
      }
      solve();
      const reference = new Float32Array(await renderer.getArrayBufferAsync(f.pressure.value));
      const error = actual.reduce((m, value, i) => Math.max(m, Math.abs(value - reference[i])), 0);
      assert(error === 0, `${name} changed pressure relative to a full operator rebuild: ${error}`);
      assert(flags.rebuilt === (name === 'rhs' ? 0 : 1), `${name} invalidated the wrong topology`);
      checks.push({ name, error, ...flags });
    }
    // Live dimensions are part of the generation independently of the owner boundary revision.
    const dimensions = f.grid.gridDimensions.clone(); dimensions.x /= 2;
    const bounds = f.grid.bounds.clone(); bounds.max.x = bounds.min.x + dimensions.x * f.spacing.value;
    f.grid.setLayoutMetadata(bounds, dimensions);
    const activate = Fn(() => {
      f.grid.slots.element(instanceIndex).assign(instanceIndex.lessThan(f.grid.brickCount)
        .select(instanceIndex.add(1), uint(0)));
      If(instanceIndex.lessThan(f.grid.brickCount),
        () => f.grid.pages.element(instanceIndex).assign(instanceIndex.add(1)));
    })().compute(f.grid.capacity);
    renderer.compute(activate); f.grid.updateDispatch(renderer); renderer.compute(f.seed); solve();
    assert((await state()).rebuilt === 1, 'Dimension change did not invalidate'); activate.dispose();
    checks.push({ name: 'dimensions', ...await state() });
    // On an Auto dirty-topology step the full work budget must exactly match Iterative.
    // Simulated live GPU count exercises the policy without allocating millions of unit-test cells.
    const liveCells = uniform(3_000_000, 'uint');
    Object.defineProperty(f.grid, 'activeCellCount', { get: () => liveCells, configurable: true });
    Object.assign(f.controls, { autoMultigrid: true, multigrid: true });
    f.projection.updateTopology(); renderer.compute(f.seed); solve();
    const fallback = new Uint32Array(await renderer.getArrayBufferAsync(f.pressure.value));
    assert((await state()).selectedMG === 0, 'Auto used MG on a dirty topology');
    Object.assign(f.controls, { autoMultigrid: false, multigrid: false });
    renderer.compute(f.seed); solve();
    const iterative = new Uint32Array(await renderer.getArrayBufferAsync(f.pressure.value));
    assert(fallback.every((value, i) => value === iterative[i]), 'Auto fallback did not preserve the fine budget');
    Object.assign(f.controls, { autoMultigrid: true, multigrid: true });
    for (let i = 0; i < 8; i++) { renderer.compute(f.seed); solve(); }
    assert((await state()).selectedMG === 1, 'Auto did not enter after stable topology');
    for (const cells of [2_300_000, 2_600_000, 2_100_000]) {
      liveCells.value = cells; renderer.compute(f.seed); solve();
      assert((await state()).selectedMG === 1, 'Auto oscillated inside its hysteresis band');
    }
    liveCells.value = 1_000_000; renderer.compute(f.seed); solve();
    assert((await state()).selectedMG === 0, 'Auto trusted stale CPU counts over the live GPU workload');
    liveCells.value = 3_000_000;
    f.controls.topologyVersion++; renderer.compute(f.seed); solve();
    assert((await state()).selectedMG === 0, 'Auto did not leave after boundary invalidation');
    return { checks, exactAutoFallback: true, stableAutoEntry: true };
  } finally { await fence(); f.dispose(); }
};
