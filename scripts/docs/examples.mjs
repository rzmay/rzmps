import fs from 'node:fs';
import { demoUrl } from './site.mjs';
import { previewDefaults } from './preview-settings.mjs';
import path from 'node:path';
import ts from 'typescript';
export const root = path.resolve(import.meta.dirname, '../..');
export const sections = [
  ['system', 'Particle System Configuration'],
  ['emitters', 'Emitters'],
  ['modules', 'Modules'],
  ['renderers', 'Renderers'],
];

/** Parse balanced regions, including nesting and repeated names, without changing source formatting. */
export function extractRegions(source, file = '<source>') {
  const regions = new Map();
  const stack = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const marker = line.match(/^\s*\/\/ #(region|endregion) docs:([\w:-]+)\s*$/);
    if (/\/\/ #(end)?region docs:/.test(line) && !marker)
      throw new Error(`${file}:${index + 1}: malformed region marker`);
    if (marker) {
      const [, kind, name] = marker;
      if (kind === 'region') stack.push({ name, line: index + 1, lines: [] });
      else {
        const current = stack.pop();
        if (!current || current.name !== name)
          throw new Error(`${file}:${index + 1}: mismatched/overlapping region ${name}`);
        const code = current.lines.join('\n');
        if (!code.trim()) throw new Error(`${file}:${current.line}: empty region ${name}`);
        regions.set(name, [...(regions.get(name) ?? []), { code, line: current.line + 1 }]);
      }
    } else for (const current of stack) current.lines.push(line);
  }
  if (stack.length) throw new Error(`${file}:${stack[0].line}: unclosed region ${stack[0].name}`);
  return regions;
}

function literal(node, imports = new Map(), propertyPath = []) {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = literal(node.left, imports, propertyPath);
    const right = literal(node.right, imports, propertyPath);
    if (typeof left === 'string' && typeof right === 'string') return left + right;
    throw new Error('Metadata concatenation must contain static strings');
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  )
    return -Number(node.operand.text);
  if (ts.isIdentifier(node) && propertyPath.join('.') === 'previewSettings.scene') {
    const reference = imports.get(node.text);
    if (!reference) throw new Error('previewSettings.scene must reference an imported scene factory');
    return reference;
  }
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(value => literal(value, imports, propertyPath));
  if (ts.isObjectLiteralExpression(node))
    return Object.fromEntries(
      node.properties.map(p => {
        if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p))
          throw new Error('Metadata must contain literal properties');
        return [
          p.name.text,
          literal(ts.isShorthandPropertyAssignment(p) ? p.name : p.initializer, imports, [
            ...propertyPath,
            p.name.text,
          ]),
        ];
      }),
    );
  if (ts.isSatisfiesExpression(node) || ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) {
    return literal(node.expression, imports, propertyPath);
  }
  throw new Error('Example metadata must contain static literal values');
}

/** Discover metadata without executing browser modules or importing their asset URLs in Node. */
export function readExampleMetadata(source, file = 'example.js') {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  if (ast.parseDiagnostics.length) throw new Error(`${file}: invalid example source`);
  const imports = new Map();
  for (const statement of ast.statements.filter(ts.isImportDeclaration)) {
    const module = statement.moduleSpecifier.text;
    if (statement.importClause?.name) imports.set(statement.importClause.name.text, { module, export: 'default' });
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings))
      for (const binding of bindings.elements) {
        imports.set(binding.name.text, { module, export: binding.propertyName?.text ?? binding.name.text });
      }
  }
  const factoryName =
    ast.statements.find(
      s => ts.isFunctionDeclaration(s) && s.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword),
    )?.name?.text ?? ast.statements.find(ts.isExportAssignment)?.expression.getText(ast);
  const assignment = ast.statements
    .filter(ts.isExpressionStatement)
    .map(s => s.expression)
    .find(
      e =>
        ts.isBinaryExpression(e) &&
        ts.isPropertyAccessExpression(e.left) &&
        e.left.name.text === 'metadata' &&
        e.left.expression.getText(ast) === factoryName,
    );
  if (!assignment) throw new Error(`${file}: missing factory.metadata`);
  const metadata = literal(assignment.right, imports);
  if (
    metadata.previewSettings != null &&
    (typeof metadata.previewSettings !== 'object' || Array.isArray(metadata.previewSettings))
  )
    throw new Error(`${file}: previewSettings must be an object`);
  if (
    metadata.previewSettings?.scene != null &&
    (typeof metadata.previewSettings.scene !== 'object' || !metadata.previewSettings.scene.module)
  ) {
    throw new Error(`${file}: previewSettings.scene must reference an imported scene factory`);
  }
  return metadata;
}

export function exampleSourcePath(example) {
  return path.join(root, 'examples', example.file);
}

export function discoverExamples() {
  const seen = new Set(),
    titles = new Set();
  return fs
    .readdirSync(path.join(root, 'examples/presets'))
    .filter(f => /\.(js|ts)$/.test(f) && !['index.js', 'types.ts'].includes(f))
    .sort()
    .map(filename => {
      const file = 'presets/' + filename;
      const source = fs.readFileSync(path.join(root, 'examples', file), 'utf8');
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const hasDefault = ast.statements.some(
        s =>
          ts.isExportAssignment(s) ||
          (ts.isFunctionDeclaration(s) && s.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)),
      );
      if (!hasDefault) throw new Error(`${file}: missing default example factory`);
      const metadata = readExampleMetadata(source, file);
      for (const field of ['id', 'title', 'description', 'category'])
        if (typeof metadata[field] !== 'string' || !metadata[field].trim())
          throw new Error(`${file}: invalid ${field}`);
      if (!/^[a-zA-Z][\w-]*$/.test(metadata.id) || seen.has(metadata.id) || titles.has(metadata.title))
        throw new Error(`${file}: invalid or duplicate id/title`);
      if (
        !Array.isArray(metadata.tags) ||
        !metadata.tags.length ||
        metadata.tags.some(t => typeof t !== 'string' || !t.trim())
      )
        throw new Error(`${file}: invalid tags`);
      const rawAuthor = metadata.author;
      const author =
        typeof rawAuthor === 'string' ? { name: rawAuthor, url: `https://github.com/${rawAuthor}` } : rawAuthor;
      if (
        !author ||
        typeof author.name !== 'string' ||
        !author.name.trim() ||
        (author.url && !/^https?:\/\//.test(author.url))
      )
        throw new Error(`${file}: provide literal factory.metadata.author (username or {name, url})`);
      seen.add(metadata.id);
      titles.add(metadata.title);
      const regions = extractRegions(source, file);
      for (const [key] of sections)
        if (![...regions.keys()].some(n => n === key || n.startsWith(key + ':')))
          throw new Error(`${file}: missing docs:${key} region`);
      return { ...metadata, author, file, regions };
    });
}
export function resolveCode(markdown, example) {
  return markdown.replace(/<ExampleCode region="([\w:-]+)"\s*\/>/g, (_, key) => {
    const matches = [...example.regions].filter(([name]) => name === key || name.startsWith(key + ':'));
    if (!matches.length) throw new Error(`${example.id}: missing source region ${key}`);
    return matches
      .flatMap(([name, entries]) =>
        entries.map(
          ({ code, line }) =>
            `\n[Source: ` +
            `${name}` +
            `](https://github.com/rzmay/rzmps/blob/develop/examples/` +
            `${example.file}` +
            `#L` +
            `${line}` +
            `)\n\n\`\`\`js\n` +
            `${code}` +
            `\n\`\`\`\n`,
        ),
      )
      .join('\n');
  });
}
export function guideTemplate(example) {
  return (
    `---\ntitle: ` +
    `${JSON.stringify(example.title)}` +
    `\nexample: ` +
    `${example.id}` +
    `\n---\n\n# ` +
    `${example.title}` +
    `\n\n` +
    `${example.description}` +
    `\n\n[View live example](` +
    `${demoUrl}` +
    `?preset=` +
    `${encodeURIComponent(example.title)}` +
    `)\n\n<ExampleAttribution />\n\n<ExamplePreview />\n\n` +
    sections
      .map(
        ([key, title]) =>
          `## ` +
          `${title}` +
          `\n\n<!-- TODO: Explain the ` +
          `${key}` +
          `, its purpose, and why the important configuration values suit this effect. ` +
          `-->\n\n<ExampleCode region="` +
          `${key}` +
          `" />\n`,
      )
      .join('\n')
  );
}
export function validateGuide(markdown, example, strict = true) {
  for (const component of ['ExampleAttribution', 'ExamplePreview']) {
    if (!markdown.includes(`<${component} />`)) throw new Error(`${example.id}: missing ${component}`);
  }
  const liveLink = markdown.match(/\[View live example\]\(([^)]+)\)/)?.[1];
  if (!liveLink) throw new Error(`${example.id}: missing live example link`);
  let liveUrl;
  try {
    liveUrl = new URL(liveLink);
  } catch {
    throw new Error(`${example.id}: invalid live example URL`);
  }
  if (liveUrl.searchParams.get('preset') !== example.title)
    throw new Error(`${example.id}: stale live example preset; expected ${example.title}`);
  let last = -1;
  for (const [key, title] of sections) {
    const index = markdown.indexOf(`## ${title}\n`);
    if (index <= last) throw new Error(`${example.id}: missing/out-of-order ${title}`);
    const end = markdown.indexOf('\n## ', index + 1);
    const body = markdown.slice(index, end < 0 ? undefined : end);
    if (!body.includes(`<ExampleCode region="${key}`))
      throw new Error(`${example.id}: ${title} needs a source reference`);
    const prose = body
      .replace(/^## .*\n/, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<ExampleCode[^>]*\/>/g, '')
      .trim();
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
  const credit = author?.url
    ? `Preset by [${author.name}](${author.url}).`
    : `Preset by ${author?.name ?? 'unknown author'}.`;
  const settings = { ...previewDefaults, ...example.previewSettings };
  const escape = value =>
    String(value).replace(
      /[&<>"']/g,
      character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
    );
  const terms = `Category: ${escape(example.category ?? '')}. Tags: ${(example.tags ?? []).map(escape).join(', ')}.`;
  return resolveCode(markdown, example)
    .replace(/<ExampleAttribution\s*\/>/g, () => `${credit}\n\n${terms}`)
    .replace(
      /<ExamplePreview\s*\/>/g,
      () =>
        `<ExampleVideo source="/previews/${example.id}.${settings.format}" ` +
        `poster="/previews/${example.id}.png" ` +
        `label="${escape(example.title)} preview" ` +
        `:width="${settings.width}" :height="${settings.height}" />`,
    );
}
