import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
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

test('cross-revision comparison maps legacy case names to CPU cases', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rzmps-benchmark-legacy-intersection-'));
  const run = (script, args) => execFileSync(process.execPath, [path.join(root, 'scripts', script), ...args], { encoding: 'utf8' });
  try {
    const base = structuredClone(snapshot);
    const head = structuredClone(snapshot);
    const legacyName = base.results[0].name;
    base.results = [base.results[0]];
    head.results = [
      { ...head.results[0], name: `${legacyName} [CPU]` },
      { ...head.results[0], name: `${legacyName} [GPU]` },
    ];
    const basePath = path.join(directory, 'base.json');
    const headPath = path.join(directory, 'head.json');
    fs.writeFileSync(basePath, JSON.stringify(base));
    fs.writeFileSync(headPath, JSON.stringify(head));

    run('intersect-benchmarks.mjs', [basePath, headPath]);
    const filteredBase = JSON.parse(fs.readFileSync(basePath));
    const filteredHead = JSON.parse(fs.readFileSync(headPath));
    assert.deepEqual(filteredBase.results.map((result) => result.name), [`${legacyName} [CPU]`]);
    assert.deepEqual(filteredHead.results.map((result) => result.name), [`${legacyName} [CPU]`]);
    assert.deepEqual(filteredHead.metadata.caseIntersection.headOnly, [`${legacyName} [GPU]`]);
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

test('benchmark retries only transient GPU failures and discards failed sample results', async () => {
  const { isRetryableBenchmarkError, runBenchmarkWithRetry } = await import('./benchmark-failures.mjs');
  const allocation = size => new RangeError(`Failed to execute 'createBuffer' on 'GPUDevice': `
    + `createBuffer failed, size (${size}) is too large for the implementation when mappedAtCreation == true`);
  assert.equal(isRetryableBenchmarkError(allocation(2048)), true);
  assert.equal(isRetryableBenchmarkError(allocation(1024 ** 3)), false);
  assert.equal(isRetryableBenchmarkError(new Error('WebGPU Device Lost: A valid external Instance reference '
    + 'no longer exists.')), true);
  assert.equal(isRetryableBenchmarkError(new Error('GPUValidationError: invalid binding')), false);
  assert.equal(isRetryableBenchmarkError(new Error('Compute pipeline creation failed')), false);
  assert.equal(isRetryableBenchmarkError(new Error('Spatial kill zones did not activate GPU processing')), false);

  const attempts = [];
  const retries = [];
  const successful = { complete: true, results: ['complete sample'] };
  const result = await runBenchmarkWithRetry(async attempt => {
    attempts.push(attempt);
    if (attempt === 1) throw allocation(2048);
    return successful;
  }, error => retries.push(error));
  assert.equal(result, successful);
  assert.deepEqual(attempts, [1, 2]);
  assert.equal(retries.length, 1);

  let failures = 0;
  await assert.rejects(runBenchmarkWithRetry(async () => {
    failures++;
    throw allocation(2048);
  }), /createBuffer failed/);
  assert.equal(failures, 2, 'persistent device failures must remain failures');

  failures = 0;
  await assert.rejects(runBenchmarkWithRetry(async () => {
    failures++;
    throw new Error('GPUValidationError: invalid binding');
  }), /GPUValidationError/);
  assert.equal(failures, 1, 'validation failures must not trigger a new sample');
});


test('report updates stream build progress before measurements finish and keep JSON out of logs', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rzmps-report-progress-'));
  const payload = path.join(directory, 'payload.json');
  const release = path.join(directory, 'release');
  const output = path.join(directory, 'export.json');
  fs.writeFileSync(payload, JSON.stringify(snapshot));
  const npm = path.join(directory, 'npm');
  fs.writeFileSync(npm, `#!${process.execPath}
import fs from 'node:fs';
console.log('fixture build progress');
console.error('[benchmark attempt 1] Case 1/1: fixture');
if (process.env.RZMPS_TEST_FAIL) process.exit(7);
const timeout = setTimeout(() => { console.error('Build progress was not streamed'); process.exit(3); }, 2000);
const timer = setInterval(() => {
  if (!fs.existsSync(process.env.RZMPS_TEST_RELEASE)) return;
  clearInterval(timer);
  clearTimeout(timeout);
  console.log('RZMPS browser benchmark');
  console.log('RZMPS_BENCHMARK_JSON_START');
  console.log(fs.readFileSync(process.env.RZMPS_TEST_PAYLOAD, 'utf8'));
  console.log('RZMPS_BENCHMARK_JSON_END');
}, 10);
`);
  fs.chmodSync(npm, 0o755);
  const run = fail => new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts/update-benchmark-report.mjs'),
      '--json-only', output], {
      env: { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}`,
        RZMPS_TEST_PAYLOAD: payload, RZMPS_TEST_RELEASE: release, RZMPS_TEST_FAIL: fail ? '1' : '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => {
      stdout += chunk;
      // The fixture cannot complete until its build log reaches this parent.
      if (stdout.includes('fixture build progress')) fs.writeFileSync(release, 'ready');
    });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolveRun({ code, stdout, stderr }));
  });
  try {
    const result = await run(false);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Building the library/);
    assert.match(result.stdout, /fixture build progress/);
    assert.match(result.stderr, /Case 1\/1: fixture/);
    assert.match(result.stdout, /Measurements complete: .* cases in .*s\. Exporting JSON/);
    assert.doesNotMatch(result.stdout, /RZMPS_BENCHMARK_JSON_START|"metadata"/);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), snapshot);

    fs.unlinkSync(output);
    const failure = await run(true);
    assert.notEqual(failure.code, 0);
    assert.match(failure.stderr, /Benchmark command failed \(exit code 7\)/);
    assert.equal(fs.existsSync(output), false, 'failed measurements must not write a report');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
