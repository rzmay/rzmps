/** Read public benchmark providers; no renderer internals, readbacks or simulation-specific traversal. */
export function readProfilerStats(benchmarks) {
  const snapshot = benchmarks?.snapshot() ?? {};
  const stats = { particles: 0, children: 0, allocated: 0, activeSlots: 0, fluids: [], renderers: [] };
  const counts = { activeLights: ['Lights', 0], playingClips: ['Audio clips', 0], activeDecals: ['Decals', 0] };
  const present = new Set();
  const systemMetrics = { particleCount: 'particles', childrenCount: 'children',
    allocatedSlots: 'allocated', usedSlots: 'activeSlots' };

  for (const [path, value] of Object.entries(snapshot)) {
    if (value == null) continue;
    const system = path.match(/(?:^|\/)system\/([^/]+)$/);
    if (system && systemMetrics[system[1]]) stats[systemMetrics[system[1]]] += value;
    const metric = path.split('/').at(-1);
    if (counts[metric]) { counts[metric][1] += value; present.add(metric); }
    if (path.endsWith('/grid/cellSize')) {
      const prefix = path.slice(0, -'grid/cellSize'.length);
      const component = prefix.match(/([^/]+)-\d+\/$/)?.[1] ?? 'Fluid';
      stats.fluids.push({ name: component.replace('Simulation', ''),
        dimensions: ['width', 'height', 'depth'].map(axis => snapshot[`${prefix}grid/${axis}`]).join(' × '),
        cellSize: Number(value.toPrecision(3)).toString() });
    }
  }
  stats.renderers = [...present].map(metric => ({ name: counts[metric][0], count: counts[metric][1] }));
  return stats;
}
