import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateBenchmark, assertComparable } from './benchmark-payload.mjs';
import { benchmarkGuide } from './docs/benchmarks.mjs';

const root = path.resolve(import.meta.dirname, '..');
const snapshot = JSON.parse(fs.readFileSync(path.join(root, 'benchmark/result.json'), 'utf8'));

test('benchmark reports reject incomplete, invalid, and incompatible measurements', () => {
  validateBenchmark(snapshot);
  const changed = mutate => { const copy = structuredClone(snapshot); mutate(copy); return copy; };
  assert.throws(() => validateBenchmark(changed(p => { p.results = []; })), /nonempty/);
  assert.throws(() => validateBenchmark(changed(p => { p.results.push(p.results[0]); })), /unique/);
  assert.throws(() => validateBenchmark(changed(p => { p.results[0].avgFps = null; })), /avgFps/);
  assert.throws(() => validateBenchmark(changed(p => { p.results[0].frames = 1; })), /insufficient/);
  assert.throws(() => assertComparable(snapshot, changed(p => { p.metadata.profile = 'ci'; })), /measurement settings/);
  assert.throws(() => assertComparable(snapshot, changed(p => { p.results.reverse(); })), /case ordering/);
});

test('aggregation and comparison use medians and preserve measurement metadata', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rzmps-benchmark-test-'));
  const run = (script, args) => execFileSync(process.execPath, [path.join(root, 'scripts', script), ...args], { encoding: 'utf8' });
  try {
    const inputs = [1, 100, 2].map((factor, index) => {
      const payload = structuredClone(snapshot);
      payload.results.forEach(row => { row.avgUpdateMs *= factor; });
      const file = path.join(directory, `${index}.json`);
      fs.writeFileSync(file, JSON.stringify(payload));
      return file;
    });
    const aggregate = path.join(directory, 'aggregate.json');
    run('aggregate-benchmarks.mjs', [aggregate, ...inputs]);
    const result = JSON.parse(fs.readFileSync(aggregate));
    assert.equal(result.metadata.sampleCount, 3);
    assert.equal(result.results[0].avgUpdateMs, snapshot.results[0].avgUpdateMs * 2);
    const markdown = path.join(directory, 'comparison.md');
    const json = path.join(directory, 'comparison.json');
    run('compare-benchmarks.mjs', [inputs[0], aggregate, markdown, json]);
    assert.match(fs.readFileSync(markdown, 'utf8'), /ABBAAB/);
    assert.ok(JSON.parse(fs.readFileSync(json)).comparisons.length);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('cross-revision comparison retains only shared benchmark cases', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rzmps-benchmark-intersection-'));
  const run = (script, args) => execFileSync(process.execPath, [path.join(root, 'scripts', script), ...args], { encoding: 'utf8' });
  try {
    const base = structuredClone(snapshot);
    const head = structuredClone(snapshot);
    const sharedName = base.results[1].name;
    base.results = [base.results[0], base.results[1]];
    head.results = [
      base.results[1],
      { ...base.results[0], name: 'PR-only benchmark' },
    ];
    const basePath = path.join(directory, 'base.json');
    const headPath = path.join(directory, 'head.json');
    fs.writeFileSync(basePath, JSON.stringify(base));
    fs.writeFileSync(headPath, JSON.stringify(head));

    run('intersect-benchmarks.mjs', [basePath, headPath]);
    const filteredBase = JSON.parse(fs.readFileSync(basePath));
    const filteredHead = JSON.parse(fs.readFileSync(headPath));
    assert.deepEqual(filteredBase.results.map((result) => result.name), [sharedName]);
    assert.deepEqual(filteredHead.results.map((result) => result.name), [sharedName]);
    assert.deepEqual(filteredBase.metadata.caseIntersection.baseOnly, [base.results[0].name]);
    assert.deepEqual(filteredHead.metadata.caseIntersection.headOnly, ['PR-only benchmark']);
    assertComparable(filteredBase, filteredHead);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('documentation includes the current published table without a second maintained snapshot', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const page = benchmarkGuide(readme);
  const report = readme.split('<!-- RZMPS_BENCHMARKS_START -->')[1].split('<!-- RZMPS_BENCHMARKS_END -->')[0];
  const rows = report.split('\n').filter(line => line.startsWith('|'));
  for (const row of rows) assert.ok(page.includes(row), row);
  assert.match(page, /npm run benchmark:update-report/);
  assert.throws(() => benchmarkGuide('# No report'), /missing/);
});
