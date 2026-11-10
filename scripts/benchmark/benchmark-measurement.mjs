/** Records measurement frames only; event-drain work is outside the measured window. */
export function recordBenchmarkFrame(benchmark, previousTime, time, updateMs, dispatches) {
  if (benchmark.phase !== 'measure') return;
  if (previousTime !== undefined) benchmark.frameSamples.push(time - previousTime);
  benchmark.updateSamples.push(updateMs);
  benchmark.computeDispatchSamples.push(dispatches.compute);
  benchmark.simulationDispatchSamples.push(dispatches.simulation);
  benchmark.renderOutputDispatchSamples.push(dispatches.renderOutput);
  benchmark.particleSamples.push(benchmark.system.liveParticleCount ?? benchmark.system.particles.length);
  benchmark.gpuActiveSamples.push(benchmark.system.isGPUProcessingActive);
  benchmark.measuredDurationMs = time - benchmark.phaseStartedAt;
}
