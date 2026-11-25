import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareDocumentation, preparationIsCurrent, rememberPreparation } from '../../scripts/prepare.utils.mjs';

test('PR preparation skips only previously successful, unchanged inputs and outputs', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rzmps-preparation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', root]);
  fs.writeFileSync(path.join(root, '.git/info/exclude'), 'output/\nnode_modules/\n');
  fs.mkdirSync(path.join(root, 'output'));
  fs.writeFileSync(path.join(root, 'output/report.json'), '{}');
  const artifacts = ['output'];
  assert.equal(preparationIsCurrent(root, artifacts), false);
  rememberPreparation(root, artifacts);
  assert.equal(preparationIsCurrent(root, artifacts), true);

  fs.writeFileSync(path.join(root, 'source.js'), 'original();\n');
  assert.equal(preparationIsCurrent(root, artifacts), false);
  rememberPreparation(root, artifacts);
  execFileSync('git', ['add', 'source.js'], { cwd: root });
  assert.equal(preparationIsCurrent(root, artifacts), true);
  fs.writeFileSync(path.join(root, 'source.js'), 'modified();\n');
  assert.equal(preparationIsCurrent(root, artifacts), false);
  rememberPreparation(root, artifacts);
  fs.writeFileSync(path.join(root, 'output/report.json'), '{"changed":true}');
  assert.equal(preparationIsCurrent(root, artifacts), false);
  rememberPreparation(root, artifacts);
  fs.unlinkSync(path.join(root, 'output/report.json'));
  assert.equal(preparationIsCurrent(root, artifacts), false);
  rememberPreparation(root, artifacts);
  fs.writeFileSync(path.join(root, 'output/stale.md'), 'obsolete generated file');
  assert.equal(preparationIsCurrent(root, artifacts), false);
});

test('current documentation is checked without regeneration', async () => {
  const calls = [];
  await prepareDocumentation(
    async (...args) => {
      calls.push(args);
      return 0;
    },
    () => {},
  );
  assert.deepEqual(calls, [[process.execPath, ['apps/docs/scripts/generate.mjs', '--check'], [2]]]);
});

test('stale documentation is regenerated after the CI freshness check', async () => {
  const calls = [];
  await prepareDocumentation(
    async (...args) => {
      calls.push(args);
      return calls.length === 1 ? 2 : 0;
    },
    () => {},
  );
  assert.deepEqual(calls, [
    [process.execPath, ['apps/docs/scripts/generate.mjs', '--check'], [2]],
    [process.execPath, ['apps/docs/scripts/generate.mjs']],
  ]);
});

test('documentation validation errors stop preparation without attempting generation', async () => {
  let calls = 0;
  await assert.rejects(
    prepareDocumentation(
      async () => {
        calls++;
        throw new Error('Invalid skill reference');
      },
      () => {},
    ),
    /Invalid skill reference/,
  );
  assert.equal(calls, 1);
});
