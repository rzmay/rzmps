/** Nearest-rank percentiles; keep scheduling intervals distinct from CPU, GPU and fence latency. */
export function frameDistribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const percentile = p => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null;
  return { count: sorted.length, median: percentile(0.5), p90: percentile(0.9), p95: percentile(0.95),
    p99: percentile(0.99), max: sorted.at(-1) ?? null,
    over16_67: sorted.filter(value => value > 16.67).length,
    over20: sorted.filter(value => value > 20).length,
    over33_33: sorted.filter(value => value > 33.33).length };
}

/** Retain event-local windows after async GPU timestamps resolve, including overlapping incidents. */
export function spikeWindows(frames, threshold = 16.67, radius = 3) {
  const windows = [];
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index];
    if (!(frame.gpu?.totalGPUms > threshold)) continue;
    const stages = Object.entries(frame.gpu.allStageGPUms).sort((a, b) => b[1] - a[1]);
    windows.push({ frame: frame.frame, gpuMs: frame.gpu.totalGPUms, largestStage: stages[0],
      // Nearby events are evidence for correlation, never automatic proof of causality.
      before: frames.slice(Math.max(0, index - radius), index), incident: frame,
      after: frames.slice(index + 1, index + radius + 1) });
  }
  return windows;
}
