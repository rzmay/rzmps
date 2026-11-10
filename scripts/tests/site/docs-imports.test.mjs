import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createServer } from 'vitepress';

const root = path.resolve(import.meta.dirname, '../../..');

test('VitePress transforms the bubbles page with its real preset watch dependency', { timeout: 15000 }, async () => {
  // Transform one authored page without building the site or generating documentation.
  const server = await createServer(path.join(root, 'apps/docs'), {
    host: '127.0.0.1',
    hmr: false,
    preTransformRequests: false,
  });
  try {
    // VitePress accepts server options, not an inline Vite config. Avoid middleware
    // mode so we can disable optimization before listen() initializes the server.
    // This test never loads the browser import graph, which can leave optimization
    // waiting indefinitely during server.close(). Keep the real Markdown plugins.
    server.config.optimizeDeps.include = [];
    server.config.optimizeDeps.noDiscovery = true;
    await server.listen(0);
    const result = await server.transformRequest('/examples/bubbles.md');
    assert.ok(result?.code);
    assert.ok(!result.code.includes('examples/index.js/bubbles.js'));
    assert.ok(result.code.includes('examples/presets/bubbles.js'), 'the watch dependency resolves to the preset');
  } finally { await server.close(); }
});
