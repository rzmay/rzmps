export const BENCHMARK_ORDER = Object.freeze(['base-a', 'head-a', 'head-b', 'base-b', 'base-c', 'head-c']);
export const REPORT_MARKER = '<!-- rzmps-benchmark-report -->';

export function benchmarkStage(stage) {
  if (![1, 2, 3].includes(stage)) throw new Error('Benchmark stage must be 1, 2 or 3');
  return {
    stage, status: ['Preliminary', 'Intermediate', 'Final'][stage - 1],
    passes: BENCHMARK_ORDER.slice(0, stage * 2),
    next: BENCHMARK_ORDER.slice((stage - 1) * 2, stage * 2),
  };
}

export function formatProgressReport(markdown, metadata, { runUrl, interrupted = false, conclusion } = {}) {
  const { stage, status, passes } = benchmarkStage(metadata.stage);
  const escape = value => String(value ?? '').replaceAll('`', '').replaceAll('\n', ' ');
  const state = interrupted ? 'Interrupted — incomplete' : status;
  const info = [
    `<!-- rzmps-benchmark-run:${metadata.runId}:${metadata.runAttempt}:${stage} -->`,
    `**Base:** \`${escape(metadata.baseRef)}@${metadata.baseSha.slice(0, 7)}\``,
    `**PR:** \`${escape(metadata.headRef)}@${metadata.headSha.slice(0, 7)}\``,
    `**Suite:** ${metadata.selection === 'full' ? 'Full' : 'PR (16 cases)'} · **Status:** ${state} · **Measurements:** ${passes.length}/6 per case`,
    `**Completed order:** ${passes.map(pass => pass.startsWith('base') ? 'A' : 'B').join('')}`,
    metadata.simulationClock === 'fixed'
      ? '**Simulation:** one fixed 1/60-second interval per rendered frame; wall-clock render timing is measured normally.'
      : '**Simulation:** wall-clock updates, including catch-up/substepping work after slow frames.',
    ...(stage < 3 || interrupted
      ? ['**Provisional results:** small differences may be measurement noise; this is not a final regression determination.']
      : ['**Complete:** all three base and three PR samples are included.']),
    ...(interrupted ? ['The workflow stopped before completing a successful final comparison. The latest available measurements are retained.'] : []),
    ...(stage === 3 && conclusion && conclusion !== 'success'
      ? [`Workflow ended with ${escape(conclusion)} after all six measurements were collected.`] : []),
    ...(runUrl ? [`[Workflow logs and detailed results](${runUrl})`] : []),
    '',
  ].join('\n');
  return markdown.replace('## 📊 Benchmark comparison\n', `## 📊 Benchmark comparison\n\n${info}\n`);
}
