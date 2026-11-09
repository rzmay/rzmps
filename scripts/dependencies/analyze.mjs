import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { warnings, compareWarnings } from './report.mjs';

const root = process.cwd();
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
const pr = event.pull_request;
if (!pr) throw new Error('Dependency comparison requires a pull request event');
const output = path.join(root, '.dependency-report');
mkdirSync(output, { recursive: true });
for (const file of ['base.json', 'head.json', 'report.json']) rmSync(path.join(output, file), { force: true });
const temporary = mkdtempSync(path.join(output, 'revisions-'));
const cruise = cwd => JSON.parse(execFileSync(process.execPath, [
  path.join(root, 'node_modules/dependency-cruiser/bin/dependency-cruiser.mjs'),
  '--config', path.join(root, '.dependency-cruiser.cjs'), '--output-type', 'json', 'packages/rzmps/src',
], { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] }));
try {
  const revision = (name, sha) => {
    const directory = path.join(temporary, name);
    mkdirSync(directory);
    const archive = execFileSync('git', ['archive', sha, 'packages/rzmps/src', 'packages/rzmps/tsconfig.json'],
      { maxBuffer: 32 * 1024 * 1024 });
    execFileSync('tar', ['-xf', '-', '-C', directory], { input: archive });
    return directory;
  };
  console.log('[dependencies] Analyzing base revision with current architecture rules');
  const base = cruise(revision('base', pr.base.sha));
  console.log('[dependencies] Analyzing PR revision');
  const head = cruise(revision('head', pr.head.sha));
  const report = {
    metadata: { repository: process.env.GITHUB_REPOSITORY, pr: pr.number,
      runId: Number(process.env.GITHUB_RUN_ID), runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      baseSha: pr.base.sha, headSha: pr.head.sha, headRepository: pr.head.repo.full_name },
    base: warnings(base), head: warnings(head),
  };
  const diff = compareWarnings(report.base, report.head);
  for (const warning of report.head) console.log(`warn ${warning.rule}: ${warning.from} → ${warning.to}`);
  console.log(`[dependencies] ${diff.added.length} new, ${diff.resolved.length} resolved, ${diff.existing.length} existing warnings`);
  for (const [file, data] of [['base.json', base], ['head.json', head], ['report.json', report]]) {
    writeFileSync(path.join(output, file), JSON.stringify(data, null, 2) + '\n');
  }
} finally { rmSync(temporary, { recursive: true, force: true }); }
