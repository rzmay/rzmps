import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';

// Reuse the bounded diagnostic fixture and its physical invariants as a regular GPU regression.
test('gas emission, heat/color and physical diffusion remain consistent across quality tiers',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'rzmps-gas-quality-'));
    try {
      const output = path.join(directory, 'quality.json');
      const runner = path.resolve(import.meta.dirname, '../../benchmarks/fluids/diagnostics/gas-quality-physics.mjs');
      await promisify(execFile)(process.execPath, [runner, output], {
        env: { ...process.env, GAS_QUALITY_ASSERT: '1' }, timeout: 110000,
      });
      const result = JSON.parse(await readFile(output, 'utf8'));
      assert.deepEqual(result.errors, []);
      for (const [name, invariant] of Object.entries(result.invariants)) {
        assert.equal(invariant.passed, true, name);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
