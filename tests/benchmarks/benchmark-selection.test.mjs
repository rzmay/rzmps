import PR_BENCHMARK_GROUPS from './fixtures/pr-groups.json' with { type: 'json' };
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  benchmarkCaseId,
  selectBenchmarkCases,
  readBenchmarkOptions,
  updateBenchmarkSystem,
} from '../../benchmarks/lib/benchmark-selection.mjs';
import { adaptBenchmarkPage } from '../../benchmarks/lib/benchmark-adapter.mjs';

const parser = createRequire(import.meta.url)('@babel/parser');
const root = path.resolve(import.meta.dirname, '../..');
const source = fs.readFileSync(path.join(root, 'apps/demo/src/pages/BenchmarkPage.jsx'), 'utf8');

// Discover the real full factory without running Chrome or constructing Three.js systems.
function fullCases() {
  const tree = parser.parse(fs.readFileSync(path.join(root, 'apps/demo/benchmarks/standard.benchmark.js'), 'utf8'), {
    sourceType: 'module',
    plugins: ['jsx'],
  });
  let definitions;
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (
      node.type === 'CallExpression' &&
      node.callee?.name === 'pairBenchmarkCases' &&
      node.arguments[0]?.type === 'ArrayExpression'
    ) {
      const entries = node.arguments[0].elements;
      if (
        entries[0]?.properties?.some(p => p.key?.name === 'name' && p.value?.value === 'Baseline 10k simulation only')
      )
        definitions = entries;
    }
    for (const value of Object.values(node))
      if (Array.isArray(value)) value.forEach(visit);
      else visit(value);
  };
  visit(tree);
  assert.ok(definitions);
  return definitions.flatMap(entry => {
    const properties = Object.fromEntries(entry.properties.filter(p => p.key?.name).map(p => [p.key.name, p.value]));
    const label =
      properties.name.type === 'ConditionalExpression' ? properties.name.consequent.value : properties.name.value;
    const modes = properties.cpuOnly?.value ? ['CPU'] : properties.gpuOnly?.value ? ['GPU'] : ['CPU', 'GPU'];
    return modes.map(mode => ({
      name: `${label} [${mode}]`,
      ...(properties.id && { id: `${properties.id.value}:${mode.toLowerCase()}` }),
    }));
  });
}

test('PR selects exactly 16 existing cases including TrailRenderer, while full retains all 33', () => {
  const full = fullCases();
  assert.equal(full.length, 33);
  assert.deepEqual(selectBenchmarkCases(full, 'full'), full);
  const selected = selectBenchmarkCases(full, 'pr');
  assert.equal(selected.length, 16);
  const ids = Object.keys(PR_BENCHMARK_GROUPS).flatMap(id => [`${id}:cpu`, `${id}:gpu`]);
  assert.deepEqual(selected.map(benchmarkCaseId), ids);
  assert.deepEqual(
    selected.slice(-2).map(row => row.name),
    ['TrailRenderer 2k rendered [CPU]', 'TrailRenderer 2k rendered [GPU]'],
  );
  assert.deepEqual(
    selectBenchmarkCases([...full].reverse(), 'pr')
      .map(benchmarkCaseId)
      .sort(),
    [...ids].sort(),
  );
  assert.throws(() => selectBenchmarkCases(full, 'other'), /Unknown/);
  // Explicit workload IDs survive display-name changes.
  const renamed = selected.map(row => ({ id: benchmarkCaseId(row), name: 'renamed label' }));
  assert.equal(selectBenchmarkCases(renamed, 'pr').length, 16);
  assert.equal(Object.keys(PR_BENCHMARK_GROUPS).length, 8);
});

test('fixed simulation work does not grow when the software renderer delivers slow frames', () => {
  const calls = [];
  const system = {
    update() {
      calls.push(['wall', Math.ceil(2 / (1 / 24))]);
    },
    advanceFrames(...args) {
      calls.push(['fixed', ...args]);
    },
  };
  updateBenchmarkSystem(system, 'wall');
  updateBenchmarkSystem(system, 'fixed');
  assert.deepEqual(calls, [
    ['wall', 48],
    ['fixed', 1, 1 / 60],
  ]);
  assert.deepEqual(readBenchmarkOptions(''), { selection: 'reported', simulationClock: 'wall' });
  assert.deepEqual(readBenchmarkOptions('?selection=pr&simulationClock=fixed'), {
    selection: 'pr',
    simulationClock: 'fixed',
  });
  assert.throws(() => readBenchmarkOptions('?selection=unknown'), /Unknown/);
});

test('matching controls are backported into legacy pages without replacing their case factories', () => {
  const legacy = `const cases = useMemo(() => (
    caseFilter ? allCases.filter(({name})=>name.includes(caseFilter)) : allCases
  ), [allCases, caseFilter]);
  active.current.system.update();
  if (elapsed >= caseDurationMs) { finish(); }`;
  const adapted = adaptBenchmarkPage(legacy);
  assert.match(adapted, /selectBenchmarkCases\(allCases, benchmarkOptions.selection\)/);
  assert.match(adapted, /updateBenchmarkSystem\(active.current.system, benchmarkOptions.simulationClock\)/);
  assert.match(adapted, /frameSamples.length >= 3/);
  parser.parse(adapted, { sourceType: 'module' });
  assert.equal(adaptBenchmarkPage(source), source);
  assert.throws(() => adaptBenchmarkPage('unknown harness'), /compatibility adapter/);
});
