import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '../..');

for (const name of ['rzmps', 'ammo', 'jolt', 'rapier']) {
  test(`${name} watch builds preserve declarations and assets across rebuilds`, { timeout: 15000 }, async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'rzmps-watch-'));
    const input = path.join(fixture, 'index.ts'), output = path.join(fixture, 'build');
    await fs.mkdir(output);
    const declaration = path.join(output, 'external.d.ts'), asset = path.join(output, 'asset.txt');
    await fs.writeFile(declaration, 'export type Preserved = number;\n');
    await fs.writeFile(asset, 'preserved asset');
    await fs.writeFile(input, 'export const marker = "first-build";\n');
    const child = spawn(path.join(root, 'node_modules/.bin/tsdown'), [input,
      '--config', path.join(root, 'packages', name, 'tsdown.config.mjs'), '--watch', '--out-dir', output,
    ], { cwd: path.join(root, 'packages', name), stdio: ['ignore', 'pipe', 'pipe'] });
    let logs = '';
    child.stdout.on('data', chunk => { logs += chunk; });
    child.stderr.on('data', chunk => { logs += chunk; });
    const closed = new Promise(resolve => child.once('close', resolve));
    const waitForBuild = async marker => {
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        const text = await fs.readFile(path.join(output, 'index.mjs'), 'utf8').catch(() => '');
        if (text.includes(marker)) return;
        if (child.exitCode !== null) break;
        await setTimeout(25);
      }
      assert.fail(`Watch output did not contain ${marker}:\n${logs}`);
    };
    try {
      await waitForBuild('first-build');
      assert.equal(await fs.readFile(declaration, 'utf8'), 'export type Preserved = number;\n');
      assert.equal(await fs.readFile(asset, 'utf8'), 'preserved asset');
      await fs.writeFile(input, 'export const marker = "second-build";\n');
      await waitForBuild('second-build');
      assert.equal(await fs.readFile(declaration, 'utf8'), 'export type Preserved = number;\n');
      assert.equal(await fs.readFile(asset, 'utf8'), 'preserved asset');
    } finally {
      child.kill('SIGINT');
      await closed;
      await fs.rm(fixture, { recursive: true, force: true });
    }
  });
}
