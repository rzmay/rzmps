import fs from 'node:fs';
import { demoUrl } from './site.mjs';
import path from 'node:path';
import ts from 'typescript';
export const root = path.resolve(import.meta.dirname, '../..');
export const sections = [['system', 'Particle System Configuration'], ['emitters', 'Emitters'], ['modules', 'Modules'], ['renderers', 'Renderers']];

/** Parse balanced regions, including nesting and repeated names, without changing source formatting. */
export function extractRegions(source, file = '<source>') {
  const regions = new Map();
  const stack = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const marker = line.match(/^\s*\/\/ #(region|endregion) docs:([\w:-]+)\s*$/);
    if (/\/\/ #(end)?region docs:/.test(line) && !marker) throw new Error(`${file}:${index + 1}: malformed region marker`);
    if (marker) {
      const [, kind, name] = marker;
      if (kind === 'region') stack.push({ name, line: index + 1, lines: [] });
      else {
        const current = stack.pop();
        if (!current || current.name !== name) throw new Error(`${file}:${index + 1}: mismatched/overlapping region ${name}`);
        const code = current.lines.join('\n');
        if (!code.trim()) throw new Error(`${file}:${current.line}: empty region ${name}`);
        regions.set(name, [...(regions.get(name) ?? []), { code, line: current.line + 1 }]);
      }
    } else for (const current of stack) current.lines.push(line);
  }
  if (stack.length) throw new Error(`${file}:${stack[0].line}: unclosed region ${stack[0].name}`);
  return regions;
}

function literal(node) {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal);
  if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.map(p => {
    if (!ts.isPropertyAssignment(p)) throw new Error('Metadata must contain literal properties');
    return [p.name.text, literal(p.initializer)];
  }));
  if (ts.isSatisfiesExpression(node) || ts.isAsExpression(node)) return literal(node.expression);
  throw new Error('Example metadata must be a static object of strings and arrays');
}
export function discoverExamples() {
  const seen = new Set(), titles = new Set();
  return fs.readdirSync(path.join(root, 'examples')).filter(f => /\.(js|ts)$/.test(f) && !['index.js','types.ts'].includes(f)).sort().map(file => {
    const source = fs.readFileSync(path.join(root, 'examples', file), 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const hasDefault = ast.statements.some(s => ts.isExportAssignment(s) || (ts.isFunctionDeclaration(s) && s.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)));
    if (!hasDefault) throw new Error(`${file}: missing default example factory`);
    const declaration = ast.statements.filter(ts.isVariableStatement).filter(s => s.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)).flatMap(s => [...s.declarationList.declarations]).find(d => d.name.getText(ast) === 'metadata');
    if (!declaration?.initializer) throw new Error(`${file}: missing exported metadata`);
    const metadata = literal(declaration.initializer);
    for (const field of ['id','title','description','category']) if (typeof metadata[field] !== 'string' || !metadata[field].trim()) throw new Error(`${file}: invalid ${field}`);
    if (!/^[a-zA-Z][\w-]*$/.test(metadata.id) || seen.has(metadata.id) || titles.has(metadata.title)) throw new Error(`${file}: invalid or duplicate id/title`);
    if (!Array.isArray(metadata.tags) || !metadata.tags.length || metadata.tags.some(t => typeof t !== 'string' || !t.trim())) throw new Error(`${file}: invalid tags`);
    const factoryName = ast.statements.find(s => ts.isFunctionDeclaration(s) && s.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword))?.name?.text
      ?? ast.statements.find(ts.isExportAssignment)?.expression.getText(ast);
    const authorAssignment = ast.statements.filter(ts.isExpressionStatement).map(s => s.expression).find(e => ts.isBinaryExpression(e) && ts.isPropertyAccessExpression(e.left) && e.left.name.text === 'author' && e.left.expression.getText(ast) === factoryName);
    const rawAuthor = authorAssignment ? literal(authorAssignment.right) : undefined;
    const author = typeof rawAuthor === 'string' ? { name: rawAuthor, url: `https://github.com/${rawAuthor}` } : rawAuthor;
    if (!author || typeof author.name !== 'string' || !author.name.trim() || (author.url && !/^https?:\/\//.test(author.url))) throw new Error(`${file}: provide literal factory.author metadata (username or {name, url})`);
    seen.add(metadata.id); titles.add(metadata.title);
    const regions = extractRegions(source, file);
    for (const [key] of sections) if (![...regions.keys()].some(n => n === key || n.startsWith(key + ':'))) throw new Error(`${file}: missing docs:${key} region`);
    return { ...metadata, author, file, regions };
  });
}
export function resolveCode(markdown, example) {
  return markdown.replace(/<ExampleCode region="([\w:-]+)"\s*\/>/g, (_, key) => {
    const matches = [...example.regions].filter(([name]) => name === key || name.startsWith(key + ':'));
    if (!matches.length) throw new Error(`${example.id}: missing source region ${key}`);
    return matches.flatMap(([name, entries]) => entries.map(({code,line}) => `\n[Source: ${name}](https://github.com/rzmay/rzmps/blob/develop/examples/${example.file}#L${line})\n\n\`\`\`js\n${code}\n\`\`\`\n`)).join('\n');
  });
}
export function guideTemplate(example) {
  return `---\ntitle: ${JSON.stringify(example.title)}\nexample: ${example.id}\n---\n\n# ${example.title}\n\n${example.description}\n\n[View live example](${demoUrl}?preset=${encodeURIComponent(example.title)})\n\n<ExampleAttribution />\n\n<ExamplePreview />\n\n` + sections.map(([key,title]) => `## ${title}\n\n<!-- TODO: Explain the ${key}, its purpose, and why the important configuration values suit this effect. -->\n\n<ExampleCode region="${key}" />\n`).join('\n');
}
export function validateGuide(markdown, example, strict = true) {
  for (const component of ['ExampleAttribution', 'ExamplePreview']) {
    if (!markdown.includes(`<${component} />`)) throw new Error(`${example.id}: missing ${component}`);
  }
  const liveLink = markdown.match(/\[View live example\]\(([^)]+)\)/)?.[1];
  if (!liveLink) throw new Error(`${example.id}: missing live example link`);
  let liveUrl;
  try { liveUrl = new URL(liveLink); }
  catch { throw new Error(`${example.id}: invalid live example URL`); }
  if (liveUrl.searchParams.get('preset') !== example.title) throw new Error(`${example.id}: stale live example preset; expected ${example.title}`);
  let last = -1;
  for (const [key,title] of sections) {
    const index = markdown.indexOf(`## ${title}\n`);
    if (index <= last) throw new Error(`${example.id}: missing/out-of-order ${title}`);
    const end = markdown.indexOf('\n## ', index + 1);
    const body = markdown.slice(index, end < 0 ? undefined : end);
    if (!body.includes(`<ExampleCode region="${key}`)) throw new Error(`${example.id}: ${title} needs a source reference`);
    const prose = body.replace(/^## .*\n/, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<ExampleCode[^>]*\/>/g, '').trim();
    if (strict && prose.length < 60) throw new Error(`${example.id}: ${title} needs an explanation`);
    last = index;
  }
  if (/TODO/.test(markdown)) {
    if (strict) throw new Error(`${example.id}: unresolved guide TODO`);
    console.warn(`${example.id}: unresolved guide TODO`);
  }
  resolveCode(markdown, example);
}

/** Resolve source-linked assets and authors without copying their data into authored guides. */
export function resolveExample(markdown, example) {
  const author = example.author;
  const credit = author?.url ? `Preset by [${author.name}](${author.url}).` : `Preset by ${author?.name ?? 'unknown author'}.`;
  return resolveCode(markdown, example)
    .replace(/<ExampleAttribution\s*\/>/g, credit)
    .replace(/<ExamplePreview\s*\/>/g, `![Generated preview of ${example.title}](/previews/${example.id}.png)`);
}
