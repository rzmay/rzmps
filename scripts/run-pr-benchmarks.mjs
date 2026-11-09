import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { benchmarkStage, formatProgressReport } from './benchmark-progress.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

/** One checkpoint executes only its new pair, then reuses all earlier sample files. */
export function runBenchmarkStage({ stage, directory, selection = 'pr', simulationClock = 'fixed',
  run = (script, args) => execFileSync(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit' }) }) {
  const plan = benchmarkStage(stage);
  const output = path.join(directory, `stage-${stage}`);
  mkdirSync(output, { recursive: true });
  const runner = path.join(root, 'apps/demo/scripts/benchmark-rzmps.mjs');
  for (const sample of plan.next) {
    const revision = sample.split('-')[0];
    console.log(`[PR benchmarks] ${sample} (${plan.status}; ${selection}; ${simulationClock} clock)`);
    run(runner, ['--vsync', '--selection', selection, '--simulation-clock', simulationClock,
      '--dist', path.join(directory, `${revision}-site`), '--output', path.join(directory, `${sample}.json`)]);
  }
  for (const revision of ['base', 'head']) {
    run(path.join(root, 'scripts/aggregate-benchmarks.mjs'), [path.join(output, `${revision}.json`),
      ...plan.passes.filter(sample => sample.startsWith(revision)).map(sample => path.join(directory, `${sample}.json`))]);
  }
  run(path.join(root, 'scripts/intersect-benchmarks.mjs'), [path.join(output, 'base.json'), path.join(output, 'head.json')]);
  run(path.join(root, 'scripts/compare-benchmarks.mjs'), [path.join(output, 'base.json'), path.join(output, 'head.json'),
    path.join(output, 'comparison.md'), path.join(output, 'comparison.json')]);
  const metadata = { ...JSON.parse(readFileSync(path.join(directory, 'metadata.json'), 'utf8')),
    stage, completedPasses: plan.passes.length, selection, simulationClock };
  writeFileSync(path.join(output, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n');
  const report = path.join(output, 'comparison.md');
  writeFileSync(report, formatProgressReport(readFileSync(report, 'utf8'), metadata,
    { runUrl: process.env.GITHUB_SERVER_URL && `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${metadata.runId}` }));
  if (stage === 3) {
    for (const file of ['base.json', 'head.json', 'comparison.md', 'comparison.json', 'metadata.json']) {
      copyFileSync(path.join(output, file), path.join(directory, file));
    }
  }
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { stage: { type: 'string' }, directory: { type: 'string' },
    selection: { type: 'string', default: 'pr' }, 'simulation-clock': { type: 'string', default: 'fixed' } } });
  if (!values.directory) throw new Error('--directory is required');
  runBenchmarkStage({ stage: Number(values.stage), directory: path.resolve(values.directory),
    selection: values.selection, simulationClock: values['simulation-clock'] });
}
