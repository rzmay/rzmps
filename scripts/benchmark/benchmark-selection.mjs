/** Stable workload IDs; display order and CPU/GPU suffix positions are not identifiers. */
export const PR_BENCHMARK_GROUPS = Object.freeze({
  'baseline-10k': 'Baseline 10k simulation only',
  'baseline-50k': 'Baseline 50k simulation only',
  'heavy-modules-10k': 'Heavy modules 10k',
  'spatial-kill-zones-10k': 'Spatial kill zones 10k',
  'spawn-churn': 'Spawn churn 2k/sec simulation only',
  'sprite-10k': 'SpriteRenderer 10k rendered',
  'mesh-rendered': 'MeshRenderer 2k rendered (low-poly)',
  'trail-2k': 'TrailRenderer 2k rendered',
});
export const PR_BENCHMARK_IDS = Object.freeze(Object.keys(PR_BENCHMARK_GROUPS)
  .flatMap(id => [`${id}:cpu`, `${id}:gpu`]));

export function benchmarkCaseId(entry) {
  if (entry.id) return entry.id;
  const mode = entry.name.match(/ \[(CPU|GPU)\]$/)?.[1].toLowerCase();
  const name = entry.name.replace(/ \[(CPU|GPU)\]$/, '');
  const group = Object.entries(PR_BENCHMARK_GROUPS).find(([, label]) => label === name)?.[0]
    ?? (name === 'MeshRenderer 10k rendered' ? 'mesh-rendered' : undefined);
  return group ? `${group}:${mode ?? 'cpu'}` : undefined;
}

export function selectBenchmarkCases(cases, selection = 'full') {
  if (selection === 'full') return cases;
  if (selection !== 'pr') throw new Error(`Unknown benchmark selection: ${selection}`);
  const selected = cases.filter(entry => PR_BENCHMARK_IDS.includes(benchmarkCaseId(entry)));
  const ids = selected.map(benchmarkCaseId);
  const missing = PR_BENCHMARK_IDS.filter(id => !ids.includes(id));
  if (missing.length || new Set(ids).size !== ids.length) {
    throw new Error(`PR benchmark selection is incomplete or ambiguous: ${missing.join(', ')}`);
  }
  return selected;
}

export function readBenchmarkOptions(search) {
  const params = new URLSearchParams(search);
  const selection = params.get('selection') ?? 'full';
  const simulationClock = params.get('simulationClock') ?? 'wall';
  if (!['pr', 'full'].includes(selection)) throw new Error(`Unknown benchmark selection: ${selection}`);
  if (!['fixed', 'wall'].includes(simulationClock)) throw new Error(`Unknown simulation clock: ${simulationClock}`);
  return { selection, simulationClock };
}

/** Keep simulation work independent of software-renderer frame latency when requested. */
export function updateBenchmarkSystem(system, simulationClock) {
  if (simulationClock === 'fixed') system.advanceFrames(1, 1 / 60);
  else if (simulationClock === 'wall') system.update();
  else throw new Error(`Unknown simulation clock: ${simulationClock}`);
}
