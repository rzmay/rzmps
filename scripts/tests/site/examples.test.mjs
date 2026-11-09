import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';

const root = path.resolve(import.meta.dirname, '../../..');

test('examples workspace resolves particle and scene entry points from demo and scripts', () => {
  for (const importer of ['apps/demo/src/pages/index.jsx', 'scripts/preview/harness.js']) {
    const require = createRequire(path.join(root, importer));
    for (const entry of ['index.js', 'scenes/index.js', 'scenes/checkerboard.js']) {
      assert.equal(require.resolve('examples/' + entry), path.join(root, 'examples', entry));
    }
  }
});

test('Vite resolves workspace imports and all relocated scene modules and assets', async () => {
  const server = await createServer({
    root: path.join(root, 'apps/demo'), configFile: path.join(root, 'apps/demo/vite.config.mjs'),
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    for (const entry of ['examples/index.js', 'examples/scenes/index.js']) {
      const resolved = await server.pluginContainer.resolveId(entry, path.join(root, 'apps/demo/src/pages/index.jsx'));
      assert.equal(resolved.id, path.join(root, entry));
    }
    for (const file of ['examples/index.js', 'examples/scenes/index.js']) {
      assert.ok((await server.transformRequest('/@fs/' + path.join(root, file)))?.code);
    }
    for (const directory of ['presets', 'scenes', 'utils']) {
      for (const file of fs.readdirSync(path.join(root, 'examples', directory)).filter(file => file.endsWith('.js'))) {
        const result = await server.transformRequest('/@fs/' + path.join(root, 'examples', directory, file));
        assert.ok(result?.code, `${directory}/${file} and its imports resolve after relocation`);
      }
    }
  } finally { await server.close(); }
});
