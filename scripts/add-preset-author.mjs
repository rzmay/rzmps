import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(new URL('..', import.meta.url).pathname);
const presetPattern = /^examples\/(?:presets|scenes)\/(?!index\.js$)[^/]+\.js$/;

function parseArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;

    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    i++;
  }

  return args;
}

function git(args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
}

function addedFiles(base) {
  if (base) {
    return git(['diff', '--name-only', '--diff-filter=A', `${base}...HEAD`]).split('\n').filter(Boolean);
  }

  return git(['diff', '--name-only', '--diff-filter=A', '--cached']).split('\n').filter(Boolean);
}

function appendAuthor(path, username) {
  const absolute = resolve(root, path);
  const source = readFileSync(absolute, 'utf8');
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const factoryName = ast.statements.find(node => ts.isFunctionDeclaration(node)
    && node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword))?.name?.text
    ?? ast.statements.find(ts.isExportAssignment)?.expression.getText(ast);
  const metadata = ast.statements.filter(ts.isExpressionStatement).map(node => node.expression)
    .find(node => ts.isBinaryExpression(node) && node.left.getText(ast) === `${factoryName}.metadata`)?.right;
  if (!metadata || !ts.isObjectLiteralExpression(metadata)) {
    console.warn(`Skipping ${path}: provide a literal factory.metadata object first.`);
    return false;
  }
  if (metadata.properties.some(property => property.name?.getText(ast).replace(/['"]/g, '') === 'author')) return false;
  const offset = metadata.getStart(ast) + 1;
  writeFileSync(absolute, source.slice(0, offset) + `\n  author: ${JSON.stringify(username)},` + source.slice(offset));
  return true;
}

const args = parseArgs(process.argv.slice(2));
const username = args['github-user'] ?? process.env.GITHUB_ACTOR;

if (!username) {
  throw new Error('Missing GitHub username. Pass --github-user or set GITHUB_ACTOR.');
}

const files = args.files
  ? args.files.split(',').map((file) => file.trim()).filter(Boolean)
  : addedFiles(args.base);

let updated = 0;

files.forEach((file) => {
  if (!presetPattern.test(file)) return;
  if (!existsSync(resolve(root, file))) return;
  if (appendAuthor(file, username)) updated++;
});

console.log(`Added preset author metadata to ${updated} file${updated === 1 ? '' : 's'}.`);
