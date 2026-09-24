import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const presetPattern = /^packages\/demo\/src\/presets\/(?:particles|scenes)\/(?!index\.js|background\.js|createCollisionObjects\.js)(.+)\.js$/;

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

function hasAuthorMetadata(source) {
  return /\.author\s*=/.test(source);
}

function defaultExportName(source) {
  return source.match(/\bexport\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/)?.[1]
    ?? source.match(/\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*;?/)?.[1];
}

function appendAuthor(path, username) {
  const absolute = resolve(root, path);
  const source = readFileSync(absolute, 'utf8');

  if (hasAuthorMetadata(source)) {
    return false;
  }

  const name = defaultExportName(source);
  if (!name) {
    console.warn(`Skipping ${path}: could not find a named default export to attach author metadata.`);
    return false;
  }

  const metadata = `${name}.author = "${username}";\n`;
  writeFileSync(absolute, `${source.trimEnd()}\n\n${metadata}`);
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
