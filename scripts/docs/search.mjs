import { discoverExamples, resolveExample } from './examples.mjs';

/** VitePress indexes raw Markdown separately from the page-transform pipeline. */
export function renderSearchPage(source, environment, markdown) {
  const id = source.match(/^example: ([\w-]+)$/m)?.[1];
  const example = id ? discoverExamples().find(entry => entry.id === id) : undefined;
  if (id && !example) throw new Error(`Unknown search example: ${id}`);
  const text = example ? `${resolveExample(source, example)}\n\n${example.title}\n\n${example.description}\n` : source;
  const html = markdown.render(text, environment);
  return environment.frontmatter?.search === false ? '' : html;
}
