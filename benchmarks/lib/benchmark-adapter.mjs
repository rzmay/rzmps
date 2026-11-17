import { fileURLToPath } from 'node:url';

export const benchmarkControlModule = fileURLToPath(new URL('./benchmark-selection.mjs', import.meta.url));

/** Backport identical selection/clock controls into a base revision's own case factory.
 * Do not replace its page or library with PR code: older revisions may lack newer APIs.
 */
export function adaptBenchmarkPage(source) {
  if (source.includes('readBenchmarkOptions(window.location.search)')) return source;
  const cases = /const cases = useMemo\(\(\) => \(([\s\S]*?)\), \[allCases, caseFilter\]\);/;
  if (!cases.test(source) || !source.includes('active.current.system.update();')) {
    throw new Error('Benchmark page cannot accept shared selection/clock controls; update its compatibility adapter');
  }
  const imports =
    'import { selectBenchmarkCases, readBenchmarkOptions, updateBenchmarkSystem ' +
    '} from ' +
    `${JSON.stringify(benchmarkControlModule)}` +
    ';\n' +
    'const benchmarkOptions = readBenchmarkOptions(window.location.search);\n';
  return (
    imports +
    source
      .replace(
        cases,
        'const cases = useMemo(() => { const selected = selectBenchmarkCases(allCases, benchmarkOptions.selection); ' +
          'return caseFilter ? selected.filter(({ name }) => name.toLowerCase().includes(caseFilter)) : selected; ' +
          '}, [allCases, caseFilter]);',
      )
      .replace(
        'active.current.system.update();',
        'updateBenchmarkSystem(active.current.system, benchmarkOptions.simulationClock);',
      )
      .replace(
        'if (elapsed >= caseDurationMs) {',
        'if (elapsed >= caseDurationMs && active.current.frameSamples.length >= 3) {',
      )
  );
}
