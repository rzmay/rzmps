import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { root, discoverExamples } from '../../scripts/docs/examples.mjs';
import { previewDirectory, validatePreviews } from '../../scripts/docs/preview-manifest.mjs';

const run = promisify(execFile);
test('docs checks reject stale previews without a browser; explicit generation repairs and reuses captures', {
  timeout: 300000,
}, async () => {
  const generate = () => run('npm', ['run', 'docs:generate'], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
  // Explicit generation is available locally; builds consume the committed captures.
  await generate();
  const manifestFile = path.join(previewDirectory, 'manifest.json');
  const manifest = await fs.readFile(manifestFile);
  const affected = ['fire', 'smoke'];
  const originals = await Promise.all(affected.map(id => fs.readFile(path.join(previewDirectory, id + '.png'))));
  const unchanged = path.join(previewDirectory, 'fireworks.png');
  const before = await fs.stat(unchanged);
  try {
    await fs.unlink(path.join(previewDirectory, 'fire.png'));
    const stale = JSON.parse(manifest);
    stale.examples.smoke.inputHash = 'outdated-source';
    await fs.writeFile(manifestFile, JSON.stringify(stale));
    const checked = () => run('npm', ['run', 'docs:generate', '--', '--check'], {
      cwd: root, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, PUPPETEER_EXECUTABLE_PATH: '/nonexistent-preview-browser' },
    });
    await assert.rejects(checked(), error => /missing or stale preview/.test(error.stderr)
      && /commit apps\/docs\/public\/previews/.test(error.stderr));
    await assert.rejects(fs.access(path.join(previewDirectory, 'fire.png')));
    const repaired = await generate();
    assert.equal((repaired.stdout.match(/Captured 1 webgl frames/g) || []).length, 2);
    validatePreviews(discoverExamples());
    for (const id of affected) {
      const png = await fs.readFile(path.join(previewDirectory, id + '.png'));
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.ok(png.length > 1000);
    }
    assert.equal((await fs.stat(unchanged)).mtimeMs, before.mtimeMs, 'unaffected PNG must not be rewritten');
    const verified = await checked();
    assert.doesNotMatch(verified.stdout, /Captured \d+|> .*build:modules/);
    const reused = await generate();
    assert.doesNotMatch(reused.stdout, /Captured \d+|> .*build:modules/);
    assert.equal((reused.stdout.match(/preview is current/g) || []).length, discoverExamples().length);
  } finally {
    // Restore the reviewed previews after the repair checks.
    for (const [index, id] of affected.entries()) {
      await fs.writeFile(path.join(previewDirectory, id + '.png'), originals[index]);
    }
    await fs.writeFile(manifestFile, manifest);
  }
});
