import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

// Reuse the ordinary demo fixtures and profile runner; a saved capture avoids repeating a measured run.
const directory = process.env.INPUT_FILE ? undefined : await fs.mkdtemp(path.join(os.tmpdir(), 'rzmps-capacity-'));
const file = process.env.INPUT_FILE ?? path.join(directory, 'startup.json');
try {
  if (!process.env.INPUT_FILE) await promisify(execFile)(process.execPath,
    ['scripts/benchmark/internal/guard-domains.mjs', file], {
      env: { ...process.env, FRAMES: '180', PREPARE: '1', EXAMPLES: 'volumetricSmoke,volumetricFire' },
      timeout: 120000,
    });
  const results = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(results.map(result => result.example), ['volumetricSmoke', 'volumetricFire']);
  for (const { example, observation, errors, error } of results) {
    assert(!error, error);
    assert.deepEqual(errors, []);
    assert(observation.samples.length >= 180);
    const initial = observation.initialCapacityDemand;
    assert(initial.bricks > 1 && initial.capacity >= initial.bricks);
    assert.equal(Math.log2(initial.capacity) % 1, 0);
    for (const sample of observation.samples) {
      const state = sample.brickState;
      const critical = state.priorityDemand.slice(3).reduce((sum, count) => sum + count, 0);
      assert(critical <= state.resident,
        `${example} frame ${sample.frame}: ${critical} physical/receiver requests, ${state.resident} resident`);
    }
    console.log(`${example}: initial ${initial.bricks} requested / ${initial.capacity} slots; no critical denials`);
  }
} finally { if (directory) await fs.rm(directory, { recursive: true, force: true }); }
