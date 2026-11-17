import configuration from '../config/sets.json' with { type: 'json' };
import { matchesRule, selectEntries } from '../../scripts/selection.utils.mjs';
import { benchmarkFeature } from './benchmark-case.utils.mjs';

export const benchmarkSets = Object.keys(configuration.sets);

export function benchmarkCaseId(entry) {
  return (
    entry.id ??
    entry.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-$/, '')
  );
}

/** Legacy revisions have no path/feature metadata. Treat their original suite as the standard workload file. */
export function selectBenchmarkCases(cases, selection = 'full', filters = {}) {
  const decorated = cases.map((entry, index) => ({
    ...entry,
    index,
    path: entry.path ?? 'apps/demo/benchmarks/standard.benchmark.js',
    backend: entry.backend ?? entry.benchmarkMode ?? entry.name.match(/ \[(CPU|GPU)\]$/)?.[1].toLowerCase(),
    feature: entry.feature ?? benchmarkFeature(entry.name, 'simulation'),
  }));
  const selected = new Set(
    selectEntries(decorated, configuration, selection)
      .filter(entry => matchesRule(entry, filters))
      .map(entry => entry.index),
  );
  return cases.filter((_entry, index) => selected.has(index));
}

export function readBenchmarkOptions(search) {
  const params = new URLSearchParams(search);
  const selection = params.get('selection') ?? 'reported';
  const simulationClock = params.get('simulationClock') ?? 'wall';
  if (!benchmarkSets.includes(selection)) throw new Error(`Unknown benchmark selection: ${selection}`);
  if (!['fixed', 'wall'].includes(simulationClock)) throw new Error(`Unknown simulation clock: ${simulationClock}`);
  return { selection, simulationClock };
}

export function updateBenchmarkSystem(system, simulationClock) {
  if (simulationClock === 'fixed') system.advanceFrames(1, 1 / 60);
  else if (simulationClock === 'wall') system.update();
  else throw new Error(`Unknown simulation clock: ${simulationClock}`);
}

/** A file may contain several features/backends; only path rules can exclude it before its cases are constructed. */
export function maySelectBenchmarkModule(sourcePath, selection) {
  const definition = configuration.sets[selection];
  if (!definition) throw new Error(`Unknown benchmark selection: ${selection}`);
  if (definition.extends && !definition.extends.some(parent => maySelectBenchmarkModule(sourcePath, parent)))
    return false;
  const include = definition.include ?? [{}];
  return (
    include.some(rule => !rule.path || matchesRule({ path: sourcePath }, { path: rule.path })) &&
    !(definition.exclude ?? []).some(
      rule => Object.keys(rule).every(key => key === 'path') && matchesRule({ path: sourcePath }, rule),
    )
  );
}
