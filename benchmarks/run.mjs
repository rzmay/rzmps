import lifecycle from './config/lifecycle.json' with { type: 'json' };
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { discoverBenchmarks } from './catalog.mjs';
import { selectEntries, matchesRule } from '../scripts/selection.utils.mjs';
import { maySelectBenchmarkModule } from './lib/benchmark-selection.mjs';

const root = path.resolve(import.meta.dirname, '..');
const configuration = JSON.parse(await fs.readFile(new URL('./config/sets.json', import.meta.url), 'utf8'));
const { values } = parseArgs({
  options: {
    set: { type: 'string', default: 'reported' },
    name: { type: 'string' },
    path: { type: 'string' },
    feature: { type: 'string' },
    backend: { type: 'string' },
    runtime: { type: 'string' },
    profile: { type: 'string' },
    output: { type: 'string' },
    split: { type: 'boolean' },
    list: { type: 'boolean' },
    'skip-build': { type: 'boolean' },
    baseline: { type: 'string' },
    repetitions: { type: 'string' },
    counts: { type: 'string' },
    vsync: { type: 'boolean' },
    'simulation-clock': { type: 'string', default: 'wall' },
  },
});
const filters = Object.fromEntries(
  ['name', 'path', 'feature', 'backend', 'runtime'].filter(key => values[key]).map(key => [key, values[key]]),
);
const all = discoverBenchmarks(root);
const nodeCases = selectEntries(
  all.filter(entry => entry.runtime === 'node'),
  configuration,
  values.set,
).filter(entry => matchesRule(entry, filters));
const browserFiles = all.filter(
  entry =>
    entry.runtime === 'browser' &&
    (!values.runtime || values.runtime === 'browser') &&
    maySelectBenchmarkModule(entry.path, values.set) &&
    (!values.path || matchesRule(entry, { path: values.path })),
);
if (!nodeCases.length && !browserFiles.length) throw new Error(`No benchmarks match ${values.set}`);
if (values.list) {
  console.log(
    JSON.stringify(
      [...nodeCases, ...browserFiles].map(({ absolute: _absolute, ...entry }) => entry),
      null,
      2,
    ),
  );
} else {
  const setDirectory = values.set.replace(/[^a-z0-9_-]/gi, '-');
  const directory = path.resolve(root, values.output ?? path.join('benchmarks/output', setDirectory));
  // Output is always a directory: all consumers read metadata+results JSON, never parse console tables.
  await fs.mkdir(directory, { recursive: true });
  async function run(args, env = {}, timeout = 0) {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: root,
        stdio: 'inherit',
        env: { ...process.env, ...env },
        timeout,
        killSignal: 'SIGKILL',
      });
      child.once('error', reject);
      child.once('exit', (code, signal) =>
        code === 0 ? resolve() : reject(new Error(`Benchmark failed (${signal ?? code})`)),
      );
    });
  }
  if (!values['skip-build']) {
    await new Promise((resolve, reject) => {
      const child = spawn('npm', ['run', 'build', '--workspace', '@rzmps/rzmps'], { cwd: root, stdio: 'inherit' });
      child.once('error', reject);
      child.once('exit', code => (code === 0 ? resolve() : reject(new Error(`Library build failed (${code})`))));
    });
  }
  const artifacts = [];
  if (browserFiles.length) {
    const site = path.join(directory, 'site');
    await run(['benchmarks/build.mjs', '--out-dir', site]);
    const output = path.join(directory, 'browser.json');
    const args = [
      'benchmarks/browser.mjs',
      '--dist',
      site,
      '--output',
      output,
      '--selection',
      values.set,
      '--simulation-clock',
      values['simulation-clock'],
    ];
    for (const key of ['name', 'path', 'feature', 'backend']) if (values[key]) args.push(`--${key}`, values[key]);
    if (values.vsync) args.push('--vsync');
    await run(args, values.profile ? { RZMPS_BENCHMARK_PROFILE: values.profile } : {});
    artifacts.push(output);
  }
  if (nodeCases.length) {
    const results = [];
    for (const entry of nodeCases) {
      const temporary = path.join(directory, 'node-sample.json');
      const options = Object.fromEntries(
        ['baseline', 'repetitions', 'counts'].filter(key => values[key]).map(key => [key, values[key]]),
      );
      await run(
        ['--expose-gc', 'benchmarks/execute-node.mjs', entry.absolute, temporary, JSON.stringify(options)],
        {},
        lifecycle.sampleTimeoutMs,
      );
      results.push({
        id: entry.id,
        name: entry.name,
        path: entry.path,
        feature: entry.feature,
        benchmarkMode: 'cpu',
        backend: 'cpu',
        ...JSON.parse(await fs.readFile(temporary, 'utf8')),
      });
      await fs.rm(temporary);
    }
    const output = path.join(directory, 'node.json');
    await fs.writeFile(
      output,
      JSON.stringify(
        {
          metadata: {
            schemaVersion: 1,
            runtime: 'node',
            selection: values.set,
            measuredAt: new Date().toISOString(),
            node: process.version,
          },
          results,
        },
        null,
        2,
      ) + '\n',
    );
    artifacts.push(output);
  }
  const splits = [];
  if (values.split) {
    for (const artifact of artifacts) {
      const payload = JSON.parse(await fs.readFile(artifact, 'utf8'));
      const groups = new Map();
      for (const row of payload.results) {
        const key = `${row.feature ?? 'uncategorized'}/${row.backend ?? row.benchmarkMode ?? 'cpu'}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      }
      for (const [key, results] of groups) {
        const output = path.join(directory, 'split', payload.metadata.runtime ?? 'browser', key + '.json');
        await fs.mkdir(path.dirname(output), { recursive: true });
        await fs.writeFile(
          output,
          JSON.stringify({ metadata: { ...payload.metadata, category: key }, results }, null, 2),
        );
        splits.push(path.relative(directory, output));
      }
    }
  }
  await fs.writeFile(
    path.join(directory, 'index.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        selection: values.set,
        artifacts: artifacts.map(file => path.relative(directory, file)),
        splits,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`Benchmark artifacts: ${directory}`);
}
