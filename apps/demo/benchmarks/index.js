import { maySelectBenchmarkModule } from '../../../benchmarks/lib/benchmark-selection.mjs';
import { ParticleSystem } from '@rzmps/rzmps';
import { normalizeBenchmarkCases } from '../../../benchmarks/lib/benchmark-case.utils.mjs';

import modules from 'virtual:rzmps-benchmark-catalog';
const defaultReadbackRate = ParticleSystem.Settings.GPU_READBACK_RATE;

export function createBenchmarkCases(context, suite = '', selection = 'full') {
  const definitions = Object.entries(modules).sort(([a], [b]) => a.localeCompare(b));
  if (suite && !definitions.some(([, definition]) => definition.id === suite))
    throw new Error(`Unknown suite: ${suite}`);
  const cases = definitions
    .filter(([file, definition]) => (suite ? definition.id === suite : maySelectBenchmarkModule(file, selection)))
    .flatMap(([file, definition]) =>
      normalizeBenchmarkCases(definition, definition.createCases(context), file, defaultReadbackRate),
    );
  for (const key of ['id', 'name']) {
    if (new Set(cases.map(entry => entry[key])).size !== cases.length) throw new Error(`Duplicate benchmark ${key}`);
  }
  return cases;
}
