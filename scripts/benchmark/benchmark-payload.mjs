export const MIN_BENCHMARK_FRAMES = 3;

/** A slow frame can exhaust the time window before enough frames have been measured. */
export function isBenchmarkMeasurementComplete(elapsedMs, durationMs, frames) {
  return elapsedMs >= durationMs && frames >= MIN_BENCHMARK_FRAMES;
}

/** Reads one atomic page snapshot so page errors cannot race the success flag. */
export function validateBenchmarkCompletion({ error, expected, results }) {
  if (error) throw new Error(typeof error === 'string' ? error : (error.message ?? String(error)));
  if (
    !Array.isArray(expected) ||
    !expected.length ||
    !Array.isArray(results) ||
    JSON.stringify(expected) !== JSON.stringify(results.map(row => row?.name))
  ) {
    throw new Error('Benchmark returned an incomplete case list');
  }
  return results;
}

export function validateBenchmark(payload) {
  if (!payload?.metadata || !Array.isArray(payload.results) || !payload.results.length) {
    throw new Error('Benchmark must contain metadata and nonempty results');
  }
  const names = new Set();
  for (const row of payload.results) {
    if (!row.name || names.has(row.name)) throw new Error('Benchmark case names must be unique');
    names.add(row.name);
    if (!Number.isFinite(row.frames) || row.frames < MIN_BENCHMARK_FRAMES) {
      throw new Error(
        `${row.name}: insufficient measured frames (${row.frames}; require at least ${MIN_BENCHMARK_FRAMES})`,
      );
    }
    for (const key of ['avgFps', 'onePercentLowFps', 'avgFrameMs', 'p99FrameMs', 'avgUpdateMs', 'p95UpdateMs']) {
      if (!Number.isFinite(row[key]) || row[key] < 0 || (!key.includes('Update') && row[key] === 0)) {
        throw new Error(`${row.name}: invalid ${key}`);
      }
    }
  }
}

export function assertComparable(base, head) {
  validateBenchmark(base);
  validateBenchmark(head);
  const settings = metadata => ({
    harnessVersion: metadata.harnessVersion,
    profile: metadata.profile,
    viewport: metadata.viewport && { width: metadata.viewport.width, height: metadata.viewport.height },
    durationMs: metadata.durationMs,
    warmupMs: metadata.warmupMs,
    framePacing: metadata.framePacing,
    selection: metadata.selection ?? 'full',
    simulationClock: metadata.simulationClock ?? 'wall',
    simulationDeltaTime: metadata.simulationDeltaTime,
    suite: metadata.suite ?? '',
    caseFilter: metadata.caseFilter ?? '',
  });
  if (JSON.stringify(settings(base.metadata)) !== JSON.stringify(settings(head.metadata))) {
    throw new Error('Cannot compare benchmarks with different harnesses or measurement settings');
  }
  if (JSON.stringify(base.results.map(row => row.name)) !== JSON.stringify(head.results.map(row => row.name))) {
    throw new Error('Cannot compare benchmarks with different case ordering');
  }
}
