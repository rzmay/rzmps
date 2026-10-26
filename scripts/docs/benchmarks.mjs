export function benchmarkGuide(readme) {
  const report = readme.match(/<!-- RZMPS_BENCHMARKS_START -->\s*([\s\S]*?)\s*<!-- RZMPS_BENCHMARKS_END -->/)?.[1];
  if (!report || !report.includes('| Case |')) throw new Error('README is missing the generated benchmark report');
  return `# Benchmarks

These measurements describe one machine and browser, rather than a performance guarantee. Particle count, modules, geometry, resolution, and hardware all affect results. Simulation-only cases still run in a browser render loop; their particle renderer does no drawing.

## Published Results

${report}

## Running Benchmarks

From the repository root, install dependencies with \`npm ci\`, then run:

\`\`\`sh
npm run benchmark:run
# Refresh the root and npm README tables from a new local measurement:
npm run benchmark:update-report
# Regenerate this page and the agent references from the README report:
npm run docs:generate
# Export a measurement without changing the published table:
npm run benchmark:export -- /tmp/rzmps-benchmark.json
\`\`\`

The default run uses a headless, uncapped browser at 1280×720. Set \`RZMPS_BENCHMARK_DURATION_MS\` and \`RZMPS_BENCHMARK_WARMUP_MS\` to change measurement windows. Use \`npm run benchmark:run -- --vsync\` for browser frame pacing or \`--headed\` to view the run.

Average update time measures \`ParticleSystem.update()\`; frame time includes the render loop. The 1% low FPS is the reciprocal of the average of the slowest 1% of measured frames. P99 frame time is reported separately. The Particles column shows the measured population, with a minimum–maximum range for workloads such as spawn churn that change population during measurement.

## Pull Request Comparisons

CI builds and runs the complete benchmark page from each revision against its matching library. Three samples per revision run in interleaved ABBAAB order; the comparison uses the median for each metric and includes only case names present in both revisions.

GitHub-hosted runners use software WebGL. The CI profile uses a 640×360 viewport, browser frame pacing, and a 2,000-particle low polygon box workload for the mesh case. Its results are useful for relative comparisons on that runner and should be interpreted separately from the published hardware results above. Completed samples, environment metadata, and available timeout diagnostics are uploaded as workflow artifacts even when a run fails.
`;
}
