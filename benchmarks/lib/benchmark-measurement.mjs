/** Records measurement frames only; event-drain work is outside the measured window. */
export function recordBenchmarkFrame(benchmark, previousTime, time, updateMs, dispatches) {
  if (benchmark.phase !== 'measure') return;
  if (benchmark.benchmarks) {
    const record = (name, value, unit = 'count') =>
      benchmark.benchmarks.record(`benchmark/${name}`, value, { type: 'gauge', unit, domain: 'value' });
    if (previousTime !== undefined) {
      benchmark.benchmarks.record('benchmark/frame', time - previousTime, { type: 'span', unit: 'ms', domain: 'cpu' });
      benchmark.measuredFrames++;
    }
    record('computeDispatches', dispatches.compute);
    record('simulationDispatches', dispatches.simulation);
    record('renderOutputDispatches', dispatches.renderOutput);
    const values = benchmark.system.benchmarks.snapshot(['system/particleCount', 'system/gpuActive']);
    record('particleCount', values['system/particleCount']);
    record('gpuActive', values['system/gpuActive']);
    benchmark.measuredDurationMs = time - benchmark.phaseStartedAt;
    return;
  }
  // Compatibility for historical base pages, which predate the Benchmarks API.
  if (previousTime !== undefined) benchmark.frameSamples.push(time - previousTime);
  benchmark.updateSamples.push(updateMs);
  benchmark.computeDispatchSamples.push(dispatches.compute);
  benchmark.simulationDispatchSamples.push(dispatches.simulation);
  benchmark.renderOutputDispatchSamples.push(dispatches.renderOutput);
  benchmark.particleSamples.push(benchmark.system.liveParticleCount ?? benchmark.system.particles.length);
  benchmark.gpuActiveSamples.push(benchmark.system.isGPUProcessingActive);
  benchmark.measuredDurationMs = time - benchmark.phaseStartedAt;
}
