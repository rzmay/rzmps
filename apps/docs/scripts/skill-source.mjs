export function generateSkill(markdown) {
  function region(name) {
    const start = `<!-- skill:${name}:start -->`,
      end = `<!-- skill:${name}:end -->`;
    if (!markdown.includes(start) || !markdown.includes(end))
      throw new Error(`Missing canonical skill region: ${name}`);
    return markdown.split(start)[1].split(end)[0].trim();
  }
  const metadata = region('metadata')
    .replace(/^```yaml\n/, '')
    .replace(/\n```$/, '');
  const routes = new Map([
    ['first-particle-system.md', 'references/getting-started.md'],
    ['concepts.md', 'references/concepts.md'],
    ['gpu-processing.md', 'references/gpu-processing.md'],
    ['../api/index.md', 'references/api.md'],
    ['../examples/index.md', 'references/examples.md'],
    ['compatibility.md', 'references/compatibility.md'],
    ['#installation', 'references/installation.md'],
  ]);
  const instructions = region('instructions').replace(/\]\(([^)]+)\)/g, (match, href) => {
    if (/^https?:/.test(href)) return match;
    if (!routes.has(href)) throw new Error(`Canonical skill link needs a portable reference: ${href}`);
    return `](${routes.get(href)})`;
  });
  return [
    '---',
    metadata,
    '---',
    '',
    '<!-- Generated from apps/docs/guides/ai-coding-assistants.md. Do not edit. -->',
    '',
    instructions,
    '',
  ].join('\n');
}

/** Direct files also work in agent file readers that do not interpret Markdown fragments. */
export function skillGuideReferences(installationGuide, gpuGuide) {
  const start = installationGuide.indexOf('## Installation\n');
  if (start < 0) throw new Error('Canonical guide is missing Installation');
  const end = installationGuide.indexOf('\n## ', start + 1);
  return [
    { file: 'gpu-processing.md', source: 'gpu-processing.md', content: gpuGuide },
    {
      file: 'installation.md',
      source: 'ai-coding-assistants.md',
      content: installationGuide.slice(start, end < 0 ? undefined : end).replace(/^## /, '# '),
    },
  ];
}
