import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { discoverFiles } from '../scripts/discover.utils.mjs';
import { matchesRule, selectEntries } from '../scripts/selection.utils.mjs';

const root = path.resolve(import.meta.dirname, '..');
const config = JSON.parse(fs.readFileSync(new URL('./config/sets.json', import.meta.url), 'utf8'));
const { values } = parseArgs({
  options: {
    set: { type: 'string', default: 'default' },
    name: { type: 'string' },
    path: { type: 'string' },
    workspace: { type: 'string' },
    list: { type: 'boolean' },
    'skip-build': { type: 'boolean' },
    concurrency: { type: 'string', default: String(config.concurrency) },
  },
});
const files = selectEntries(discoverFiles(root, 'tests', /(?:\.test\.mjs|\.types\.ts)$/), config, values.set).filter(
  entry =>
    matchesRule(
      entry,
      Object.fromEntries(['name', 'path', 'workspace'].filter(key => values[key]).map(key => [key, values[key]])),
    ),
);
if (!files.length) throw new Error(`No tests match set ${values.set}`);
if (values.list) {
  console.log(
    JSON.stringify(
      files.map(({ absolute: _absolute, ...file }) => file),
      null,
      2,
    ),
  );
} else {
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Test concurrency must be a positive integer');
  function run(command, args) {
    console.log(`[tests] ${command} ${args.join(' ')}`);
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
      child.once('error', reject);
      child.once('exit', (code, signal) =>
        code === 0 ? resolve() : reject(new Error(`Tests failed (${signal ?? code})`)),
      );
    });
  }
  if (!values['skip-build']) await run('npm', ['run', 'build', '--workspace', '@rzmps/rzmps']);
  const types = files.filter(file => file.path.endsWith('.types.ts'));
  if (types.length) {
    const require = createRequire(import.meta.url);
    await run(process.execPath, [
      require.resolve('typescript/bin/tsc'),
      '--noEmit',
      '--target',
      'esnext',
      '--module',
      'esnext',
      '--moduleResolution',
      'bundler',
      '--strict',
      '--types',
      'three',
      ...types.map(f => f.path),
    ]);
  }
  const runtime = files.filter(file => file.path.endsWith('.test.mjs'));
  if (runtime.length)
    await run(process.execPath, ['--test', `--test-concurrency=${concurrency}`, ...runtime.map(f => f.path)]);
}
