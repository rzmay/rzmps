import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import path from 'node:path';
import { selectBenchmarkCases } from '../../../benchmarks/lib/benchmark-selection.mjs';

const demo = path.resolve(import.meta.dirname, '..');

test('all browser workload modules construct unique cases and preserve the reported/PR selections', async () => {
  const server = await createServer({
    root: demo,
    configFile: path.join(demo, 'vite.config.mjs'),
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom',
  });
  try {
    const { createBenchmarkCases } = await server.ssrLoadModule('/benchmarks/index.js');
    const full = createBenchmarkCases({ ciProfile: true });
    const reported = selectBenchmarkCases(full, 'reported');
    const pr = selectBenchmarkCases(full, 'pr');
    assert.ok(full.length > reported.length);
    assert.equal(new Set(full.map(entry => entry.id)).size, full.length);
    assert.equal(reported.length, 33);
    assert.equal(pr.length, 16);
    assert.ok(pr.some(entry => entry.name === 'TrailRenderer 2k rendered [CPU]'));
    assert.ok(pr.some(entry => entry.name === 'TrailRenderer 2k rendered [GPU]'));
    const spatialGPU = selectBenchmarkCases(full, 'spatial', { backend: '^gpu$' });
    assert.ok(spatialGPU.length > 0);
    assert.ok(spatialGPU.every(entry => entry.backend === 'gpu' && entry.feature.startsWith('spatial')));
    assert.ok(full.every(entry => typeof entry.readbackRate === 'number' && entry.path.endsWith('.benchmark.js')));
  } finally {
    await server.close();
  }
});
