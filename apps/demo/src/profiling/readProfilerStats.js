/** Read public benchmark providers; no renderer internals, readbacks or simulation-specific traversal. */
export function readProfilerStats(benchmarks) {
  const snapshot = benchmarks?.snapshot() ?? {};
  const stats = { particles: 0, children: 0, allocated: 0, activeSlots: 0, systems: [], fluids: [], renderers: [] };
  const componentNames = benchmarks?.componentNames?.() ?? {};
  const counts = { activeLights: ['Lights', 0], playingClips: ['Audio clips', 0], activeDecals: ['Decals', 0] };
  const present = new Set();
  const systemMetrics = { particleCount: 'particles', childrenCount: 'children',
    allocatedSlots: 'allocated', usedSlots: 'activeSlots' };

  for (const [path, value] of Object.entries(snapshot)) {
    if (value == null) continue;
    const system = path.match(/(?:^|\/)system\/([^/]+)$/);
    if (system && systemMetrics[system[1]]) stats[systemMetrics[system[1]]] += value;
    if (system?.[1] === 'particleCount') {
      const prefix = path.slice(0, -'system/particleCount'.length);
      const name = componentNames[prefix.replace(/\/$/, '')];

      if (name) stats.systems.push({ name, particles: value,
        children: snapshot[`${prefix}system/childrenCount`] ?? 0 });
    }
    const metric = path.split('/').at(-1);
    if (counts[metric]) { counts[metric][1] += value; present.add(metric); }
    if (path.endsWith('/grid/cellSize')) {
      const prefix = path.slice(0, -'grid/cellSize'.length);
      const component = prefix.match(/([^/]+)-\d+\/$/)?.[1] ?? 'Fluid';
      stats.fluids.push({ name: component.replace('Simulation', ''),
        scope: prefix.slice(0, prefix.indexOf('modules/')),
        dimensions: ['width', 'height', 'depth'].map(axis => snapshot[`${prefix}grid/${axis}`]).join(' × '),
        cellSize: Number(value.toPrecision(3)).toString(),
        pressureSubmissionMs: snapshot[`${prefix}pressureSolve`] ?? null,
        residentPages: snapshot[`${prefix}residentPages`] ?? snapshot[`${prefix}activeBricks`] ?? null });
    }
  }
  // Surface work stays in the same fluid section; these are CPU submission spans, not GPU time.
  const extraction = Object.entries(snapshot).filter(([path]) =>
    /renderers\/SurfaceRenderer-\d+\/surfaceExtraction$/.test(path));
  for (const fluid of stats.fluids) if (fluid.name === 'FLIP')
    fluid.surfaceSubmissionMs = extraction.filter(([path]) => path.startsWith(`${fluid.scope}renderers/`))
      .reduce((sum, [, value]) => sum + (value ?? 0), 0);
  stats.renderers = [...present].map(metric => ({ name: counts[metric][0], count: counts[metric][1] }));
  stats.gpuUsage = stats.allocated > 0 ? stats.activeSlots / stats.allocated : 0;
  return stats;
}
