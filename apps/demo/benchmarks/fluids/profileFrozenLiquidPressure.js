import { passTimer } from '../../../../benchmarks/lib/passTimer.js';

/** Compare pressure algorithms on identical frozen input, excluding compilation and restoring warm pressure. */
export default async function profileFrozenLiquidPressure(flip, renderer) {
  const projection = flip.getPressureProjection(), device = renderer.backend.device;
  const original = projection.controls;
  const createPipeline = renderer.backend.createComputePipeline;
  const excessiveBindings = [];
  renderer.backend.createComputePipeline = function (pipeline, ...args) {
    const code = pipeline.computeProgram.code;
    if ((code.match(/var<storage/g)?.length ?? 0) > 8) {
      excessiveBindings.push({ code, bindings: args[0].map(group => group.bindings.map(binding => ({
        name: binding.name, attribute: binding.attribute ? Object.entries(projection)
          .find(([, value]) => value === binding.attribute)?.[0] : undefined,
      }))) });
    }
    return createPipeline.call(this, pipeline, ...args);
  };
  const saved = new Float32Array(await renderer.getArrayBufferAsync(flip.pressureCurrentAttribute));
  const reset = cold => {
    const attribute = flip.pressureCurrentAttribute;
    const buffer = renderer.backend.get(attribute).buffer;
    device.queue.writeBuffer(buffer, 0, cold ? new Float32Array(saved.length) : saved);
  };
  const results = [], unsupported = new Set();
  const timer = passTimer(device, renderer.backend, () => 'liquid/pressure solve');
  try {
    for (const cold of [false, true]) for (const [method, budget] of [
      ['iterative', 28], ['multigrid', 28], ['multigrid', 56],
    ]) {
      if (unsupported.has(method)) continue;
      projection.controls = () => ({ ...original(), minIterations: budget, maxIterations: budget,
        tolerance: 0, warmStart: true, diagnostics: false, stage: undefined,
        multigrid: method === 'multigrid', autoMultigrid: false });
      const solve = () => projection.solve(renderer, flip.velocityNext, flip.velocityCurrent, budget);
      // Compile every variant before timestamp capture; every measured solve has the same input pressure.
      device.pushErrorScope('validation');
      reset(cold); solve(); await device.queue.onSubmittedWorkDone();
      const validation = await device.popErrorScope();
      if (validation) {
        unsupported.add(method);
        results.push({ method, cold, budget, unsupported: validation.message });
        continue;
      }
      const times = [];
      for (let i = 0; i < 7; i++) {
        reset(cold); timer.start(); solve();
        times.push((await timer.finish()).totalGPUms);
      }
      const diagnostics = await projection.readDiagnostics(renderer, flip.velocityCurrent);
      times.sort((a, b) => a - b);
      results.push({ method, cold, budget, medianGPUms: times[3], ...diagnostics });
    }
    return { cellWidth: flip.cellSize, capacity: flip.workGrid.capacity,
      cellsPerPage: flip.workGrid.cellsPerBrick, tolerance: flip.pressureTolerance,
      warmStart: flip.pressureWarmStart, results, excessiveBindings };
  } finally {
    renderer.backend.createComputePipeline = createPipeline;
    projection.controls = original; reset(false); timer.dispose();
  }
}
