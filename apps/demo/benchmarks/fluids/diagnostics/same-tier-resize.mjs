// Controlled resize comparison. Build swapping is sequential and always restored, including on failure.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const build = path.resolve('packages/rzmps/build/index.mjs');
const baseline = process.argv[2];
const current = await fs.readFile(build);
const results = {};
try {
  for (const variant of baseline ? ['before', 'after'] : ['after']) {
    await fs.writeFile(build, variant === 'before' ? await fs.readFile(baseline) : current);
    const output = `/tmp/rzmps-resize-${variant}.json`;
    const { stdout } = await run(process.execPath,
      ['apps/demo/tests/fluids/same-tier-resize.browser.test.mjs'], {
        env: { ...process.env, KIND: 'gas', CHANGE: 'grow', OUTPUT: output,
          BASELINE: variant === 'before' ? '1' : '' },
        timeout: 120000, maxBuffer: 1024 * 1024,
      });
    results[variant] = JSON.parse(await fs.readFile(output, 'utf8'));
    console.log(stdout.trim());
  }
  await fs.writeFile('/tmp/rzmps-resize-comparison.json', JSON.stringify(results, null, 2));
} finally {
  await fs.writeFile(build, current);
}
