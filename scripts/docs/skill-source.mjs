export function generateSkill(markdown) {
  function region(name) {
    const start = `<!-- skill:${name}:start -->`, end = `<!-- skill:${name}:end -->`;
    if (!markdown.includes(start) || !markdown.includes(end)) throw new Error(`Missing canonical skill region: ${name}`);
    return markdown.split(start)[1].split(end)[0].trim();
  }
  const metadata = region('metadata').replace(/^```yaml\n/, '').replace(/\n```$/, '');
  const routes = new Map([
    ['first-particle-system.md', 'references/getting-started.md'],
    ['concepts.md', 'references/concepts.md'],
    ['../api/index.md', 'references/api.md'],
    ['../examples/index.md', 'references/examples.md'],
    ['compatibility.md', 'references/compatibility.md'],
    ['#installation', 'references/concepts.md#installation'],
  ]);
  const instructions = region('instructions').replace(/\]\(([^)]+)\)/g, (match, href) => {
    if (/^https?:/.test(href)) return match;
    if (!routes.has(href)) throw new Error(`Canonical skill link needs a portable reference: ${href}`);
    return `](${routes.get(href)})`;
  });
  return `---\n${metadata}\n---\n\n<!-- Generated from apps/docs/guides/ai-coding-assistants.md. Do not edit. -->\n\n${instructions}\n`;
}
