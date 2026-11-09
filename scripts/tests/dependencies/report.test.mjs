import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parse } from 'yaml';
import { warnings, compareWarnings, validateReport, formatReport, isOlderReport, MARKER } from '../../dependencies/report.mjs';
import { commentDependencies } from '../../dependencies/comment.mjs';

const warning = (from = 'src/a.ts', to = 'src/b.ts') => ({ rule: 'cycle', from, to, cycle: [to, from] });
function fixture() {
  const run = { id: 10, run_attempt: 2, event: 'pull_request', name: 'CI', path: '.github/workflows/ci.yml',
    status: 'completed', head_sha: 'head', head_repository: { full_name: 'fork/rzmps' },
    pull_requests: [{ number: 3 }], html_url: 'https://github.com/owner/rzmps/actions/runs/10' };
  const pr = { number: 3, state: 'open', head: { sha: 'head', repo: { full_name: 'fork/rzmps' } },
    base: { sha: 'base', repo: { full_name: 'owner/rzmps' } } };
  const report = { metadata: { repository: 'owner/rzmps', pr: 3, runId: 10, runAttempt: 2,
    baseSha: 'base', headSha: 'head', headRepository: 'fork/rzmps' },
    base: [warning(), warning('removed')], head: [warning(), warning('added')] };
  return { run, pr, report };
}

test('compares warning identities, not ordering, and rejects invalid analyzer output', () => {
  const base = [warning(), warning('removed')];
  const head = [warning('added'), warning()];
  assert.deepEqual(compareWarnings(base, head), { added: [warning('added')], resolved: [warning('removed')], existing: [warning()] });
  const input = { summary: { violations: [{ from: 'a', to: 'b', rule: { name: 'boundary', severity: 'warn' } }] } };
  assert.deepEqual(warnings(input), [{ rule: 'boundary', from: 'a', to: 'b', cycle: [] }]);
  input.summary.violations[0].rule.severity = 'error';
  assert.throws(() => warnings(input), /warning-only/);
  assert.throws(() => warnings({}), /Invalid dependency/);
});

test('validates fork report identity against the live PR, repository and workflow attempt', () => {
  const { run, pr, report } = fixture();
  assert.equal(validateReport(report, run, pr, 'owner/rzmps'), true);
  assert.equal(validateReport(report, { ...run, pull_requests: [] }, pr, 'owner/rzmps'), true);
  for (const metadata of [{ pr: 4 }, { runId: 11 }, { runAttempt: 1 }, { repository: 'other/rzmps' }]) {
    assert.throws(() => validateReport({ ...report, metadata: { ...report.metadata, ...metadata } }, run, pr, 'owner/rzmps'), /identity/);
  }
  assert.equal(validateReport(report, run, { ...pr, head: { ...pr.head, sha: 'new' } }, 'owner/rzmps'), false);
  assert.equal(validateReport(report, run, { ...pr, base: { ...pr.base, sha: 'new' } }, 'owner/rzmps'), false);
  assert.equal(validateReport(report, run, { ...pr, state: 'closed' }, 'owner/rzmps'), false);
  assert.equal(validateReport(report, { ...run, head_repository: { full_name: 'other/rzmps' } }, pr, 'owner/rzmps'), false);
  assert.equal(validateReport(report, { ...run, pull_requests: [{ number: 9 }] }, pr, 'owner/rzmps'), false);
  assert.throws(() => validateReport({ ...report, head: [{ from: 4 }] }, run, pr, 'owner/rzmps'), /Invalid dependency warning/);
});

test('comment includes new/resolved/existing counts, escapes paths and bounds large reports', () => {
  const { report, run } = fixture();
  const body = formatReport(report, run.html_url);
  assert.match(body, /New: 1 · Resolved: 1 · Existing: 1/);
  assert.match(body, /<details>/);
  assert.match(body, /Cycle:/);
  assert.match(body, /dependency-report-2/);
  report.head = Array.from({ length: 500 }, (_, index) => warning('`<script>@someone' + index + 'x'.repeat(4000)));
  const large = formatReport(report, run.html_url);
  assert.ok(large.length < 65000);
  assert.ok(!large.includes('<script>') && !large.includes('@someone'));
  assert.match(large, /Additional warnings/);
  assert.equal(isOlderReport('<!-- rzmps-dependency-run:11:1 -->', run), true);
  assert.equal(isOlderReport('<!-- rzmps-dependency-run:10:3 -->', run), true);
  assert.equal(isOlderReport('<!-- rzmps-dependency-run:10:1 -->', run), false);
});

function observer({ comments = [], liveChange = false, runChange = {}, artifact = true } = {}) {
  const { run, pr, report } = fixture();
  Object.assign(run, runChange);
  const writes = [];
  let reads = 0;
  const listArtifacts = () => {};
  const listComments = () => {};
  const github = {
    rest: { actions: { getWorkflowRun: async () => ({ data: run }), listWorkflowRunArtifacts: listArtifacts },
      pulls: { get: async () => ({ data: liveChange && ++reads > 1 ? { ...pr, state: 'closed' } : pr }) },
      issues: { listComments, createComment: async args => writes.push({ create: args }),
        updateComment: async args => writes.push({ update: args }) } },
    paginate: async fn => fn === listArtifacts ? artifact ? [{ name: 'dependency-report-2' }] : [] : comments,
  };
  return { writes, github, context: { repo: { owner: 'owner', repo: 'rzmps' }, payload: { workflow_run: { ...run } } },
    core: { info() {} }, download: async () => report };
}

test('observer creates once, updates its existing comment, and ignores human marker comments', async () => {
  const first = observer({ comments: [{ user: { type: 'User' }, body: MARKER }] });
  await commentDependencies(first);
  assert.equal(first.writes[0].create.issue_number, 3);
  const next = observer({ comments: [{ id: 7, user: { type: 'Bot' }, body: first.writes[0].create.body }] });
  await commentDependencies(next);
  assert.equal(next.writes.length, 0);
  next.download = async () => { const { report } = fixture(); report.head = []; return report; };
  await commentDependencies(next);
  assert.equal(next.writes[0].update.comment_id, 7);
});

test('observer skips stale reports, missing artifacts, changed PRs and other workflows', async () => {
  for (const options of [{ liveChange: true }, { artifact: false }, { runChange: { event: 'push' } },
    { runChange: { path: '.github/workflows/other.yml' } },
    { comments: [{ user: { type: 'Bot' }, body: MARKER + '\n<!-- rzmps-dependency-run:11:1 -->' }] }]) {
    const input = observer(options);
    await commentDependencies(input);
    assert.deepEqual(input.writes, []);
  }
  const invalid = observer();
  invalid.download = async () => { const { report } = fixture(); report.metadata.repository = 'wrong/repo'; return report; };
  await assert.rejects(commentDependencies(invalid), /identity/);
  assert.deepEqual(invalid.writes, []);
});

test('CI analysis has read-only permissions; privileged reporting uses trusted checkout', () => {
  const ci = parse(fs.readFileSync('.github/workflows/ci.yml', 'utf8'));
  const comment = parse(fs.readFileSync('.github/workflows/dependency-comment.yml', 'utf8'));
  assert.deepEqual(ci.permissions, { contents: 'read' });
  const analysis = ci.jobs['test-and-build'].steps.find(step => step.run === 'node scripts/dependencies/analyze.mjs');
  assert.ok(analysis);
  assert.equal(analysis['continue-on-error'], undefined);
  const upload = ci.jobs['test-and-build'].steps.find(step => step.uses === 'actions/upload-artifact@v4');
  assert.equal(upload.with['include-hidden-files'], true);
  assert.equal(upload.with.path, '.dependency-report/*.json');
  assert.deepEqual(comment.on.workflow_run, { workflows: ['CI'], types: ['completed'] });
  assert.equal(comment.permissions.issues, 'write');
  const checkout = comment.jobs.comment.steps.find(step => step.uses === 'actions/checkout@v4');
  assert.equal(checkout.with.ref, '${{ github.event.repository.default_branch }}');
  assert.equal(checkout.with['persist-credentials'], false);
  assert.ok(!comment.jobs.comment.steps.some(step => step.run?.includes('npm')));
});
