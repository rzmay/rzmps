import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatProgressReport, REPORT_MARKER, benchmarkStage } from './benchmark-progress.mjs';
import { assertComparable } from './benchmark-payload.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Read only known JSON entries; never extract or execute files supplied by PR artifacts. */
export async function downloadCheckpoint(github, repo, artifact) {
  const response = await github.rest.actions.downloadArtifact({ ...repo, artifact_id: artifact.id, archive_format: 'zip' });
  const directory = mkdtempSync(path.join(tmpdir(), 'rzmps-benchmark-artifact-'));
  try {
    const archive = path.join(directory, 'checkpoint.zip');
    writeFileSync(archive, Buffer.from(response.data));
    const json = name => JSON.parse(execFileSync('unzip', ['-p', archive, name],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 10000 }));
    return { metadata: json('metadata.json'), base: json('base.json'), head: json('head.json') };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

export function validateCheckpoint(payload, run, stage, pr) {
  const { metadata, base, head } = payload;
  benchmarkStage(stage);
  if (!Number.isSafeInteger(metadata.pr) || metadata.pr <= 0 || metadata.pr !== pr.number
    || metadata.stage !== stage || metadata.runId !== run.id || metadata.runAttempt !== run.run_attempt
    || metadata.completedPasses !== stage * 2 || !['pr', 'full'].includes(metadata.selection)
    || !['fixed', 'wall'].includes(metadata.simulationClock)) throw new Error('Invalid benchmark checkpoint identity');
  if (pr.state !== 'open' || pr.head.sha !== metadata.headSha || pr.base.sha !== metadata.baseSha
    || run.head_sha !== metadata.headSha || pr.head.repo?.full_name !== run.head_repository?.full_name
    || (run.pull_requests?.length && !run.pull_requests.some(entry => entry.number === pr.number))) {
    return false;
  }
  assertComparable(base, head);
  if (base.metadata.sampleCount !== stage || head.metadata.sampleCount !== stage
    || base.metadata.selection !== metadata.selection || base.metadata.simulationClock !== metadata.simulationClock
    || (metadata.selection === 'pr' && base.results.length !== 16)) throw new Error('Checkpoint sample counts/settings do not match its stage');
  return true;
}

export function reportWouldGoBackwards(body, run, stage) {
  const match = body?.match(/<!-- rzmps-benchmark-run:(\d+):(\d+):(\d+) -->/);
  if (!match) return false;
  const previous = match.slice(1).map(Number);
  const next = [run.id, run.run_attempt, stage];
  for (let index = 0; index < next.length; index++) {
    if (previous[index] !== next[index]) return previous[index] > next[index];
  }
  return false;
}

export function compareCheckpoint(payload) {
  const directory = mkdtempSync(path.join(tmpdir(), 'rzmps-benchmark-report-'));
  try {
    for (const revision of ['base', 'head']) writeFileSync(path.join(directory, `${revision}.json`), JSON.stringify(payload[revision]));
    const markdown = path.join(directory, 'comparison.md');
    execFileSync(process.execPath, [path.join(root, 'scripts/benchmark/compare-benchmarks.mjs'),
      path.join(directory, 'base.json'), path.join(directory, 'head.json'), markdown, path.join(directory, 'comparison.json')],
    { timeout: 10000, stdio: 'pipe' });
    return readFileSync(markdown, 'utf8');
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

/** Trusted workflow observer: no PR checkout, dependencies, shell commands or write token in the measured job. */
export async function reportBenchmarkProgress({ github, context, core, download = downloadCheckpoint,
  compare = compareCheckpoint, sleep = pause, pollMs = 15000, maxPolls = 96 }) {
  const repo = context.repo;
  const initial = context.payload.workflow_run;
  let cached;
  let published;
  let failures = 0;
  for (let poll = 0; poll < maxPolls; poll++) {
    try {
      const { data: run } = await github.rest.actions.getWorkflowRun({ ...repo, run_id: initial.id });
      if (run.run_attempt !== initial.run_attempt || run.name !== 'PR Benchmarks' || run.event !== 'pull_request') return;
      const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts,
        { ...repo, run_id: run.id, per_page: 100 });
      const candidates = artifacts.filter(artifact => !artifact.expired)
        .map(artifact => ({ artifact, stage: Number(artifact.name.match(new RegExp(`^benchmark-stage-${run.run_attempt}-([123])$`))?.[1]) }))
        .filter(entry => entry.stage).sort((a,b) => b.stage-a.stage);
      const candidate = candidates[0];
      if (candidate && (!cached || cached.metadata.stage < candidate.stage)) {
        const payload = await download(github, repo, candidate.artifact);
        if (!Number.isSafeInteger(payload.metadata?.pr) || payload.metadata.pr <= 0) throw new Error('Invalid PR number in artifact');
        const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: payload.metadata.pr });
        if (!validateCheckpoint(payload, run, candidate.stage, pr)) {
          core.info('Skipping a stale or mismatched benchmark report');
          return;
        }
        cached = { ...payload, metadata: { ...payload.metadata, baseRef: pr.base.ref, headRef: pr.head.ref } };
      }
      if (cached) {
        const interrupted = run.status === 'completed' && cached.metadata.stage < 3;
        const key = `${cached.metadata.stage}:${interrupted}:${run.status === 'completed' ? run.conclusion : 'running'}`;
        if (published !== key) {
          // Recheck the live PR and attempt before each write, including an interruption update.
          const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: cached.metadata.pr });
          if (!validateCheckpoint(cached, run, cached.metadata.stage, pr)) return;
          const comments = await github.paginate(github.rest.issues.listComments,
            { ...repo, issue_number: pr.number, per_page: 100 });
          const existing = comments.find(comment => comment.user?.type === 'Bot' && comment.body?.includes(REPORT_MARKER));
          if (reportWouldGoBackwards(existing?.body, run, cached.metadata.stage)) return;
          const body = formatProgressReport(compare(cached), cached.metadata,
            { runUrl: run.html_url, interrupted, conclusion: run.status === 'completed' ? run.conclusion : undefined });
          if (existing?.body !== body) {
            if (existing) await github.rest.issues.updateComment({ ...repo, comment_id: existing.id, body });
            else await github.rest.issues.createComment({ ...repo, issue_number: pr.number, body });
          }
          published = key;
          core.info(`Published benchmark stage ${cached.metadata.stage}: ${interrupted ? 'interrupted' : 'available'}`);
        }
      } else core.info('Waiting for the first complete benchmark pair');
      failures = 0;
      if (run.status === 'completed') return;
    } catch (error) {
      core.warning(`Benchmark reporting failed; measurements are preserved: ${error.message ?? error}`);
      if (++failures >= 5) return;
    }
    await sleep(pollMs);
  }
  core.warning('Stopped observing benchmarks before the workflow completed; its completion event will retry reporting');
}
