import path from 'node:path';
import { discoverExamples, resolveExample, exampleSourcePath, root } from './examples.mjs';

const escapeHTML = value =>
  String(value).replace(
    /[&<>"']/g,
    character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );

/** Index metadata explicitly without exposing presentation markup as result titles. */
export function renderSearchPage(source, environment, markdown) {
  const id = source.match(/^example: ([\w-]+)$/m)?.[1];
  const example = id ? discoverExamples().find(entry => entry.id === id) : undefined;
  if (id && !example) throw new Error(`Unknown search example: ${id}`);
  const html = markdown.render(example ? resolveExample(source, example) : source, environment);
  if (environment.frontmatter?.search === false) return '';
  if (!example) return html;
  const metadata = [example.description, ...example.tags, `Preset by ${example.author.name}`].map(escapeHTML).join(' ');
  return html.replace(/<h1\b([^>]*)>([\s\S]*?)<\/h1>/, (_heading, attributes, content) => {
    // Preserve the actual page anchor, but exclude author links from the title:
    // VitePress's section extractor mistakes the first <a> for its heading anchor.
    const anchor = content.match(/<a\b[^>]*class="[^"]*\bheader-anchor\b[^"]*"[^>]*>[\s\S]*?<\/a>/)?.[0] ?? '';
    return `<h1${attributes}>${escapeHTML(example.title)} Preset${anchor}</h1>\n<p>${metadata}</p>`;
  });
}

/** VitePress refreshes local search for Markdown changes, not factory changes. */
export function exampleSearchPlugin(discover = discoverExamples) {
  const directory = path.join(root, 'examples/presets');
  let signatures = new Map();
  const signature = ({ id, title, description, tags, author }) =>
    JSON.stringify({ id, title, description, tags, author });
  return {
    name: 'rzmps-example-search',
    configureServer(server) {
      signatures = new Map(discover().map(example => [exampleSourcePath(example), signature(example)]));
      server.watcher.add(directory);
    },
    async handleHotUpdate({ file, server }) {
      if (path.dirname(file) !== directory || !/\.(js|ts)$/.test(file)) return;
      const example = discover().find(entry => exampleSourcePath(entry) === file);
      if (!example || signatures.get(file) === signature(example)) return;
      signatures.set(file, signature(example));
      // This VitePress version adds duplicate document IDs when a Markdown search
      // entry is reindexed. Restart to build a fresh index for changed metadata;
      // ordinary simulation edits retain normal HMR and its current scene state.
      await server.restart();
      return [];
    },
  };
}
