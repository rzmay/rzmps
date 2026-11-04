// Rebuilt locally and in CI. Everything else emitted by the docs generator stays committed.
export const buildArtifacts = [
  'apps/docs/api/',
  'apps/docs/guides/index.md',
  'apps/docs/guides/benchmarks.md',
  'apps/docs/examples/index.md',
  'apps/docs/.vitepress/api.generated.json',
  'apps/docs/.vitepress/examples.generated.json',
  'apps/docs/public/llms.txt',
  'apps/docs/public/llms-full.txt',
  'apps/docs/public/favicon.png',
  'examples/index.js',
  'packages/rzmps/AGENTS.md',
];
export const isBuildArtifact = file => buildArtifacts.some(entry => entry.endsWith('/') ? file.startsWith(entry) : file === entry);
