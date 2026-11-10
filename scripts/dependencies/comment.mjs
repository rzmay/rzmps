import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MARKER, validateReport, formatReport, isOlderReport } from './report.mjs';

/** Read a single known JSON member without extracting or executing PR artifact content. */
export async function downloadReport(github, repo, artifact) {
  if (artifact.size_in_bytes > 8 * 1024 * 1024) throw new Error('Dependency artifact is too large');
  const response = await github.rest.actions.downloadArtifact({
    ...repo,
    artifact_id: artifact.id,
    archive_format: 'zip',
  });
  const directory = mkdtempSync(path.join(tmpdir(), 'rzmps-dependencies-'));
  try {
    const archive = path.join(directory, 'report.zip');
    writeFileSync(archive, Buffer.from(response.data));
    return JSON.parse(
      execFileSync('unzip', ['-p', archive, 'report.json'], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        timeout: 10000,
      }),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function commentDependencies({ github, context, core, download = downloadReport }) {
  const repo = context.repo;
  const eventRun = context.payload.workflow_run;
  const { data: run } = await github.rest.actions.getWorkflowRun({ ...repo, run_id: eventRun.id });
  if (
    run.event !== 'pull_request' ||
    run.name !== 'CI' ||
    run.path?.split('@')[0] !== '.github/workflows/ci.yml' ||
    run.status !== 'completed' ||
    run.run_attempt !== eventRun.run_attempt
  )
    return;
  const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, {
    ...repo,
    run_id: run.id,
    per_page: 100,
  });
  const artifact = artifacts.find(item => !item.expired && item.name === `dependency-report-${run.run_attempt}`);
  if (!artifact) {
    core.info('No completed dependency analysis report for this run');
    return;
  }
  const report = await download(github, repo, artifact);
  if (!Number.isSafeInteger(report?.metadata?.pr) || report.metadata.pr <= 0) throw new Error('Invalid PR number');
  const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: report.metadata.pr });
  const repository = `${repo.owner}/${repo.repo}`;
  if (!validateReport(report, run, pr, repository)) {
    core.info('Skipping stale or mismatched dependency report');
    return;
  }
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...repo,
    issue_number: pr.number,
    per_page: 100,
  });
  const existing = comments.find(item => item.user?.type === 'Bot' && item.body?.includes(MARKER));
  if (isOlderReport(existing?.body, run)) return;
  // Check the live PR again immediately before writing, including its base revision.
  const { data: current } = await github.rest.pulls.get({ ...repo, pull_number: pr.number });
  if (!validateReport(report, run, current, repository)) return;
  const body = formatReport(report, run.html_url);
  if (existing?.body === body) return;
  if (existing) await github.rest.issues.updateComment({ ...repo, comment_id: existing.id, body });
  else await github.rest.issues.createComment({ ...repo, issue_number: pr.number, body });
}
