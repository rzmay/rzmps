import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createServer } from 'vitepress';

const root = path.resolve(import.meta.dirname, '../../..');

test('VitePress transforms the bubbles page with its real preset watch dependency', { timeout: 15000 }, async () => {
  // Transform one authored page without building the site or generating documentation.
  const server = await createServer(path.join(root, 'apps/docs'), { middlewareMode: true, hmr: false });
  try {
    const result = await server.transformRequest('/examples/bubbles.md');
    assert.ok(result?.code);
    assert.ok(!result.code.includes('examples/index.js/bubbles.js'));
    assert.ok(result.code.includes('examples/presets/bubbles.js'), 'the watch dependency resolves to the preset');
  } finally { await server.close(); }
});
