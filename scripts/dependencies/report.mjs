export const MARKER = '<!-- rzmps-dependency-report -->';

export function warnings(result) {
  if (!Array.isArray(result?.summary?.violations)) throw new Error('Invalid dependency analysis result');
  return result.summary.violations.map(violation => {
    if (violation.rule?.severity !== 'warn' || !['from', 'to'].every(key => typeof violation[key] === 'string')
      || typeof violation.rule.name !== 'string') throw new Error('Expected warning-only dependency analysis');
    return { rule: violation.rule.name, from: violation.from, to: violation.to,
      cycle: (violation.cycle ?? []).map(entry => entry.name) };
  });
}

const key = warning => JSON.stringify([warning.rule, warning.from, warning.to, warning.cycle]);
export function compareWarnings(base, head) {
  const before = new Map(base.map(warning => [key(warning), warning]));
  const after = new Map(head.map(warning => [key(warning), warning]));
  return {
    added: [...after].filter(([id]) => !before.has(id)).map(([, value]) => value),
    resolved: [...before].filter(([id]) => !after.has(id)).map(([, value]) => value),
    existing: [...after].filter(([id]) => before.has(id)).map(([, value]) => value),
  };
}

function validateWarnings(list) {
  if (!Array.isArray(list) || list.length > 10000) throw new Error('Invalid warning list');
  for (const item of list) {
    if (!item || !['rule', 'from', 'to'].every(field => typeof item[field] === 'string' && item[field].length <= 4096)
      || !Array.isArray(item.cycle) || item.cycle.length > 1000
      || !item.cycle.every(value => typeof value === 'string' && value.length <= 4096)) throw new Error('Invalid dependency warning');
  }
}

export function validateReport(report, run, pr, repository) {
  const metadata = report?.metadata;
  if (!metadata || metadata.repository !== repository || metadata.runId !== run.id
    || metadata.runAttempt !== run.run_attempt || metadata.pr !== pr.number) throw new Error('Invalid dependency report identity');
  validateWarnings(report.base); validateWarnings(report.head);
  return pr.state === 'open' && metadata.baseSha === pr.base.sha && metadata.headSha === pr.head.sha
    && metadata.headSha === run.head_sha && pr.base.repo.full_name === repository
    && metadata.headRepository === pr.head.repo?.full_name
    && metadata.headRepository === run.head_repository?.full_name
    && (!run.pull_requests?.length || run.pull_requests.some(item => item.number === pr.number));
}

const code = value => '`' + value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('`', 'ˋ').replaceAll('@', '@\u200b').replace(/[\r\n\t]/g, ' ') + '`';

export function formatReport(report, runUrl) {
  const diff = compareWarnings(report.base, report.head);
  let remaining = 42000;
  const details = (title, entries) => {
    const rows = [];
    for (const warning of entries.slice(0, 50)) {
      const row = `- ${code(warning.rule)}: ${code(warning.from)} → ${code(warning.to)}`
        + (warning.cycle.length ? `\n  Cycle: ${warning.cycle.map(code).join(' → ')}` : '');
      if (row.length > remaining) break;
      rows.push(row); remaining -= row.length;
    }
    return `<details>\n<summary>${title} (${entries.length})</summary>\n\n${rows.join('\n') || 'None.'}`
      + (rows.length < entries.length ? '\n\nAdditional warnings are available in the full report artifact.' : '')
      + '\n\n</details>';
  };
  const { metadata } = report;
  return [MARKER, `<!-- rzmps-dependency-run:${metadata.runId}:${metadata.runAttempt} -->`,
    '## Dependency analysis',
    `**New: ${diff.added.length} · Resolved: ${diff.resolved.length} · Existing: ${diff.existing.length}**`,
    `Base: ${report.base.length} warnings · PR: ${report.head.length} warnings.`,
    `Compared ${code(metadata.baseSha.slice(0, 12))} → ${code(metadata.headSha.slice(0, 12))} using the same current rules for both revisions.`,
    'Architectural warnings do not block CI. Analysis execution failures still fail the CI step.',
    details('New warnings', diff.added), details('Resolved warnings', diff.resolved),
    details('Existing warnings', diff.existing),
    `[Full results and CI logs](${runUrl}) — download the dependency-report-${metadata.runAttempt} artifact for complete JSON results.`,
  ].join('\n\n');
}

export function isOlderReport(body, run) {
  const previous = body?.match(/<!-- rzmps-dependency-run:(\d+):(\d+) -->/);
  return !!previous && (Number(previous[1]) > run.id
    || Number(previous[1]) === run.id && Number(previous[2]) > run.run_attempt);
}
