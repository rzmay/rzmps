/** Benchmark descriptors provide createCases(context) for browser workloads or run(options) for Node. */
export function benchmarkFeature(name, fallback) {
  for (const [pattern, feature] of [
    [/sprite/i, 'rendering/sprite'],
    [/mesh|snow/i, 'rendering/mesh'],
    [/trail/i, 'rendering/trail'],
    [/collision/i, 'collision'],
    [/boid/i, 'spatial/boids'],
    [/spatial|force field/i, 'spatial'],
    [/spawn|emitter|emission/i, 'emission'],
    [/module/i, 'modules'],
  ]) {
    if (pattern.test(name)) return feature;
  }
  return fallback;
}

export function normalizeBenchmarkCases(definition, entries, sourcePath, readbackRate) {
  if (!definition.id || !definition.feature || !Array.isArray(entries))
    throw new Error(`Invalid benchmark: ${sourcePath}`);
  return entries.map(entry => {
    if (!entry.name || !(entry.create || entry.createSystem || entry.run))
      throw new Error(`Benchmark ${sourcePath} needs named runnable cases`);
    const backend = entry.backend ?? entry.benchmarkMode ?? (entry.requireGPU ? 'gpu' : 'cpu');
    const slug = entry.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-$/, '');
    return {
      ...entry,
      id: entry.id ?? `${definition.id}/${slug}`,
      path: sourcePath,
      feature: entry.feature ?? benchmarkFeature(entry.name, definition.feature),
      backend,
      benchmarkMode: backend,
      readbackRate: definition.readbackRate ?? readbackRate,
    };
  });
}
