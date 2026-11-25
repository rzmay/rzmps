import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const receiptPath = root => path.join(root, 'node_modules/.cache/rzmps/pr-prepare.json');

function preparationFingerprint(root, artifacts) {
  const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
  const files = new Set(tracked);
  // Only inspect explicit build outputs, never recursively scan the repository or dependencies.
  function collect(relative) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) return;
    if (fs.lstatSync(file).isDirectory()) {
      for (const entry of fs.readdirSync(file)) collect(path.join(relative, entry));
    } else files.add(relative);
  }
  for (const artifact of artifacts) collect(artifact);
  const environment = Object.entries(process.env)
    .filter(([name]) => /^(RZMPS_|PUPPETEER_|NODE_ENV$|CI$)/.test(name))
    .sort(([a], [b]) => a.localeCompare(b));
  const hash = createHash('sha256').update(
    JSON.stringify([process.version, process.platform, process.arch, environment]),
  );
  for (const relative of [...files].sort()) {
    hash.update(relative).update('\0');
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) hash.update('missing');
    else if (fs.lstatSync(file).isSymbolicLink()) hash.update(fs.readlinkSync(file));
    else hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function preparationIsCurrent(root, artifacts = []) {
  try {
    const receipt = JSON.parse(fs.readFileSync(receiptPath(root), 'utf8'));
    return receipt.fingerprint === preparationFingerprint(root, artifacts);
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return false;
    throw error;
  }
}

export function rememberPreparation(root, artifacts = []) {
  const file = receiptPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ fingerprint: preparationFingerprint(root, artifacts) }) + '\n');
}

export async function prepareDocumentation(run, log = console.log) {
  // Match CI's authoritative freshness check. Exit 2 means stale output; other failures must remain visible.
  const code = await run(process.execPath, ['apps/docs/scripts/generate.mjs', '--check'], [2]);
  if (code === 2) {
    log('[pr:prepare] Documentation is stale; regenerating documentation and the published skill.');
    await run(process.execPath, ['apps/docs/scripts/generate.mjs']);
  } else log('[pr:prepare] Documentation is up to date; skipping regeneration.');
}
