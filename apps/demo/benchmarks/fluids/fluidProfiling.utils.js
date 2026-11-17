/** Snapshot-independent statistics shared by gas and liquid benchmark reports. */
export function median(values) {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  return finite.length ? finite[Math.floor(finite.length / 2)] : null;
}

export function summarizeFluidTimings(state) {
  const stages = [...new Set(state.gpuSamples.flatMap(sample =>
    Object.keys(sample.allStageGPUms ?? sample.stageGPUms)))];
  return {
    cpuSubmissionMedianMs: median(state.cpuSubmissionMs),
    samples: state.gpuSamples.length,
    gpuExecutionMedianMs: Object.fromEntries(['simulationGPUms', 'lightingGPUms', 'volumeComputeGPUms',
      'surfaceComputeGPUms', 'secondaryGPUms', 'computeGPUms', 'renderGPUms', 'totalGPUms']
      .map(key => [key, median(state.gpuSamples.map(sample => sample[key]))])),
    gpuStageMedianMs: Object.fromEntries(stages.map(key => [key,
      median(state.gpuSamples.map(sample => (sample.allStageGPUms ?? sample.stageGPUms)[key] ?? 0))])),
    timingConvention: 'GPU interval unions per frame; stage medians are not additive. '
      + 'CPU submission and fenced wall time are separate. Render timestamps cover the scene pass.',
  };
}

/** Split dispatch arrays only while profiling; restoration leaves production submission unchanged. */
export function profileFluidStages(renderer, owners, state, classify = (_node, stage) => stage) {
  const compute = renderer.compute, restorations = [];
  renderer.compute = function (nodes, ...args) {
    const previous = state.stage;
    try {
      for (const node of Array.isArray(nodes) ? nodes : [nodes]) {
        state.stage = classify(node, previous ?? 'other');
        compute.call(this, node, ...args);
      }
    } finally { state.stage = previous; }
  };

  for (const [owner, label] of owners) {
    if (!owner) continue;
    const span = owner.benchmarks.span;
    owner.benchmarks.span = function (name, callback) {
      const previous = state.stage, key = typeof label === 'function' ? label(name) : `${label}/${name}`;
      state.stage = key;
      const start = performance.now();
      try { return span.call(this, name, callback); } finally {
        state.cpuStages ??= {};
        state.cpuStages[key] = (state.cpuStages[key] ?? 0) + performance.now() - start;
        state.stage = previous;
      }
    };
    restorations.push(() => { owner.benchmarks.span = span; });
  }

  return () => { renderer.compute = compute; restorations.reverse().forEach(restore => restore()); };
}

/** Attribute work that has no component span without changing its execution or return type. */
export function profileMethod(owner, method, state, stage) {
  const original = owner[method];
  owner[method] = function (...args) {
    const previous = state.stage;
    state.stage = stage;
    try { return original.apply(this, args); } finally { state.stage = previous; }
  };
  return () => { owner[method] = original; };
}

/** Count completed simulation substeps, rather than inferring execution from the requested frame dt. */
export function trackSimulationTime(system) {
  const time = { requestedSeconds: 0, executedSeconds: 0, skippedSeconds: 0, substeps: 0 };
  const interval = system._advanceSimulationInterval, step = system._advanceSimulationStep;
  const skip = system._skipSimulationTime;
  system._advanceSimulationInterval = function (...args) {
    time.requestedSeconds += this.deltaTime;
    return interval.apply(this, args);
  };
  system._advanceSimulationStep = function (...args) {
    const result = step.apply(this, args);
    time.executedSeconds += this.deltaTime;
    time.substeps++;
    return result;
  };
  system._skipSimulationTime = function (seconds, ...args) {
    time.skippedSeconds += seconds;
    return skip.call(this, seconds, ...args);
  };
  return { time, restore() {
    system._advanceSimulationInterval = interval;
    system._advanceSimulationStep = step;
    system._skipSimulationTime = skip;
  } };
}
