import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '../../..');

test('library relative imports resolve to non-ignored files with exact filename casing', () => {
  const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
  const exact = new Set(tracked);
  const folded = new Map(tracked.map(file => [file.toLowerCase(), file]));
  const errors = [];
  for (const file of tracked.filter(file => file.startsWith('packages/rzmps/src/') && file.endsWith('.ts'))) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const { fileName: specifier } of ts.preProcessFile(source, true, true).importedFiles) {
      if (!specifier.startsWith('.')) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      const candidates = [
        target,
        ...['.ts', '.tsx', '.js', '.mjs', '.json', '/index.ts', '/index.js'].map(extension => target + extension),
        ...(target.endsWith('.js') ? [target.slice(0, -3) + '.ts'] : []),
      ];
      if (candidates.some(candidate => exact.has(candidate))) continue;
      const mismatch = candidates.map(candidate => folded.get(candidate.toLowerCase())).find(Boolean);
      if (mismatch) errors.push(`${file}: ${specifier} resolves only without case sensitivity; Git lists ${mismatch}`);
      else errors.push(`${file}: ${specifier} is missing or ignored by Git`);
    }
  }
  assert.deepEqual(errors, [], errors.join('\n'));
});
