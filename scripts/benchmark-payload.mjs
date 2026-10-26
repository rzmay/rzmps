export function validateBenchmark(payload) {
  if (!payload?.metadata || !Array.isArray(payload.results) || !payload.results.length) {
    throw new Error('Benchmark must contain metadata and nonempty results');
  }
  const names = new Set();
  for (const row of payload.results) {
    if (!row.name || names.has(row.name)) throw new Error('Benchmark case names must be unique');
    names.add(row.name);
    if (!Number.isFinite(row.frames) || row.frames < 3) throw new Error(`${row.name}: insufficient measured frames`);
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
    viewport: metadata.viewport,
    durationMs: metadata.durationMs,
    warmupMs: metadata.warmupMs,
    framePacing: metadata.framePacing,
  });
  if (JSON.stringify(settings(base.metadata)) !== JSON.stringify(settings(head.metadata))) {
    throw new Error('Cannot compare benchmarks with different harnesses or measurement settings');
  }
  if (JSON.stringify(base.results.map(row => row.name)) !== JSON.stringify(head.results.map(row => row.name))) {
    throw new Error('Cannot compare benchmarks with different case ordering');
  }
}
