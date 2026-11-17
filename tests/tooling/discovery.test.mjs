import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverFiles } from '../../scripts/discover.utils.mjs';
import { selectEntries } from '../../scripts/selection.utils.mjs';
import { discoverBenchmarks } from '../../benchmarks/catalog.mjs';
import { browserArguments } from '../../scripts/browser/launch.utils.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rzmps-discovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, content = '') => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  };
  write('apps/demo/package.json', '{}');
  write('packages/library/package.json', '{}');
  return { root, write };
}

test('discovery gathers workspace-owned tests and skips fixtures, outputs and dependencies', t => {
  const { root, write } = fixture(t);
  for (const file of [
    'tests/tooling/a.test.mjs',
    'apps/demo/tests/b.test.mjs',
    'packages/library/tests/c.test.mjs',
    'examples/tests/d.test.mjs',
    'tests/fixtures/fake.test.mjs',
    'tests/output/fake.test.mjs',
    'tests/node_modules/fake.test.mjs',
    'scripts/tests/obsolete.test.mjs',
  ])
    write(file);
  assert.deepEqual(
    discoverFiles(root, 'tests', /\.test\.mjs$/).map(entry => entry.workspace),
    ['.', 'examples', 'apps/demo', 'packages/library'],
  );
});

test('sets inherit parent restrictions, union parents, and apply regex exclusions', () => {
  const entries = [
    { name: 'sprites', path: 'standard.js', backend: 'gpu' },
    { name: 'trails', path: 'standard.js', backend: 'cpu' },
    { name: 'extra', path: 'other.js', backend: 'gpu' },
  ];
  const config = {
    sets: {
      reported: { include: [{ path: '^standard' }] },
      gpu: { include: [{ backend: '^gpu$' }] },
      pr: { extends: ['reported'], exclude: [{ name: 'sprites' }] },
      union: { extends: ['reported', 'gpu'] },
      cycle: { extends: ['cycle'] },
    },
  };
  assert.deepEqual(selectEntries(entries, config, 'pr'), [entries[1]]);
  assert.deepEqual(selectEntries(entries, config, 'union'), entries);
  assert.throws(() => selectEntries(entries, config, 'cycle'), /Cyclic/);
  assert.throws(() => selectEntries(entries, config, 'missing'), /Unknown/);
});

test('benchmark catalog reads descriptors without executing workload modules', t => {
  const { root, write } = fixture(t);
  write(
    'apps/demo/benchmarks/sample.benchmark.js',
    `
    throw new Error('Listing must not execute this module');
    export default { id: 'sample', name: 'Sample', feature: 'simulation', runtime: 'browser',
      backends: ['cpu', 'gpu'], createCases() { throw new Error('Do not execute'); } };
  `,
  );
  const [entry] = discoverBenchmarks(root);
  assert.equal(entry.id, 'sample');
  assert.deepEqual(entry.backends, ['cpu', 'gpu']);
  write('packages/library/benchmarks/bad.benchmark.mjs', 'export default {};');
  assert.throws(() => discoverBenchmarks(root), /required literal metadata/);
});

test('browser profiles retain Linux software rendering and explicit pacing without affecting native flags', () => {
  const linux = browserArguments({ platform: 'linux', ci: true, profile: 'benchmark', vsync: false });
  assert.ok(linux.includes('--no-sandbox'));
  assert.ok(linux.includes('--use-angle=swiftshader'));
  assert.ok(linux.includes('--disable-frame-rate-limit'));
  assert.equal(new Set(linux).size, linux.length);
  const native = browserArguments({ platform: 'darwin', ci: false, profile: 'test' });
  assert.ok(!native.includes('--no-sandbox'));
  assert.ok(!native.includes('--disable-frame-rate-limit'));
  assert.throws(() => browserArguments({ profile: 'unknown' }), /Unknown browser profile/);
});

test('workspace preview commands keep generated output under the repository output root', () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "const {parseOptions}=await import('./preview/capture.mjs'); console.log(parseOptions([]).output);",
    ],
    { cwd: path.join(root, 'scripts'), encoding: 'utf8' },
  ).trim();
  assert.equal(output, path.join(root, 'tests/output/previews/fire'));
});
