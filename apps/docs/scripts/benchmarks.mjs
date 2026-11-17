export function benchmarkGuide(readme) {
  const report = readme.match(/<!-- RZMPS_BENCHMARKS_START -->\s*([\s\S]*?)\s*<!-- RZMPS_BENCHMARKS_END -->/)?.[1];
  if (!report || !report.includes('| Case |')) throw new Error('README is missing the generated benchmark report');
  return (
    `# Benchmarks

These measurements describe one machine and browser, rather ` +
    'than a performance guarantee. Particle count, modules, geometry, ' +
    'resolution, and hardware all affect results. Simulation-only cases still ' +
    `run in a browser render loop; their particle renderer does no drawing.

## ` +
    `Published Results

` +
    `${report}` +
    `

## Running Benchmarks

From the repository root, install dependencies ` +
    `with \`npm ci\`, then run:

\`\`\`sh
npm run benchmarks -- --set reported
# Refresh README tables from the measured artifact:
npm run update-report --workspace @rzmps/benchmarks
# Regenerate this page and agent references from the README report:
npm run generate --workspace @rzmps/docs
# Select categories and export JSON artifacts without changing README tables:
npm run benchmarks -- --set full --backend gpu --feature spatial --split
\`\`\`

The default run uses a headless, uncapped browser at 1280×720. Shared measurement
profiles and lifecycle deadlines live in \`benchmarks/config/\`; launch profiles live
in \`scripts/config/browser.json\`. Environment overrides remain available. Use
\`--vsync\` for browser frame pacing. Generated JSON artifacts are ignored under
\`benchmarks/output/<set>/\`. Definitions live with their owning workspace in
\`benchmarks/\`; the root runner discovers them by filename and regex selection sets.
The full set includes every discovered category; the reported set contains the standard
33 browser cases. See the
[benchmark workspace README](https://github.com/rzmay/rzmps/blob/HEAD/benchmarks/README.md)
for the descriptor format, options and output contract.

Average update time measures \`ParticleSystem.update()\`; frame ` +
    'time includes the render loop. The 1% low FPS is the reciprocal of the ' +
    'average of the slowest 1% of measured frames. P99 frame time is reported ' +
    'separately. The Particles column shows the measured population, with a ' +
    'minimum–maximum range for workloads such as spawn churn that change ' +
    `population during measurement.

## Pull Request Comparisons

Routine PR ` +
    'comparisons select 16 workloads through JSON name/path rules, including CPU/GPU ' +
    'TrailRenderer cases. Full coverage retains all 33 cases and is available ' +
    'through manual workflow dispatch or the `benchmark:full` PR label. Each ' +
    'revision keeps its own case factories and matching library; shared ' +
    `selection and simulation-clock controls are applied to both.

PR runs ` +
    'advance one fixed 1/60-second simulation interval per rendered frame. This ' +
    'prevents slow software rendering from causing additional catch-up steps ' +
    'only on revisions supporting substepping. Render/frame timing is still ' +
    'measured normally. Manual full runs default to wall-clock simulation, which ' +
    'includes catch-up behavior; either clock can be chosen explicitly. Reports ' +
    `identify the clock, and incompatible clocks cannot be compared.

Three ` +
    'samples per revision retain ABBAAB order and the existing ' +
    'median/geometric-mean calculations. The same PR comment is updated after AB ' +
    '(preliminary, 2/6 measurements), ABBA (intermediate, 4/6), and ABBAAB ' +
    '(final, 6/6). Failed workflows retain the latest available pair and mark it ' +
    'interrupted. Checkpoints reuse completed sample files without rebuilding or ' +
    `rerunning measurements.

The read-only benchmark job uploads checkpoints. A ` +
    'trusted default-branch `workflow_run` observer validates their ' +
    'PR/commit/run identity before posting, including for forks. Progressive ' +
    'reporting becomes active once that trusted workflow and its helper scripts ' +
    'are on the repository default branch. Logs and detailed artifacts are ' +
    `linked from the comment.

Each case measures for at least the configured ` +
    `duration and three frames. Event-drain work is excluded
from frame samples ` +
    'and measured duration. Case transitions pause rendering and drain submitted ' +
    `GPU work
outside the measurement windows. The attempt deadline covers ` +
    `browser startup, hardware probes, and
measurement; failure diagnostics and ` +
    'cleanup have separate short deadlines. Cleanup preserves the ' +
    `original
measurement error and attempts to close every resource. Late GPU ` +
    `validation failures invalidate saved
results. The runner also releases the ` +
    'benchmark renderer before closing Chromium. A device loss during ' +
    `measurement, or the
known small mapped-buffer allocation failure, discards ` +
    `the entire sample and permits one fresh-browser retry.
Validation failures ` +
    'and application errors are not retried. Output metadata records ' +
    `\`sampleAttempts\`, and
failed-attempt diagnostics remain alongside the ` +
    `successful sample; partial results never enter aggregation.

GitHub-hosted ` +
    'runners use software WebGL. The CI profile uses a 640×360 viewport, browser ' +
    'frame pacing, and a 2,000-particle low polygon box workload for the mesh ' +
    'case. Its results are useful for relative comparisons on that runner and ' +
    'should be interpreted separately from the published hardware results above. ' +
    'Completed samples, environment metadata, and available timeout diagnostics ' +
    `are uploaded as workflow artifacts even when a run fails.
`
  );
}
