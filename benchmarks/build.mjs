import path from 'node:path';
import { parseArgs } from 'node:util';
import { build } from 'vite';
import { browserCatalogPlugin } from './lib/browser-catalog-plugin.mjs';
import react from '@vitejs/plugin-react';
import { adaptBenchmarkPage, benchmarkControlModule } from './lib/benchmark-adapter.mjs';

const root = path.resolve(import.meta.dirname, '..');
const { values } = parseArgs({
  options: {
    'library-root': { type: 'string', default: root },
    'out-dir': { type: 'string', default: path.join(root, 'benchmarks/output/site') },
  },
});
const libraryRoot = path.resolve(values['library-root']);
const demoRoot = path.join(libraryRoot, 'apps/demo');

// Build each revision's benchmark page against its matching library. This lets
// branches add or remove API-dependent cases without breaking the other build.
await build({
  configFile: false,
  root: demoRoot,
  plugins: [
    {
      name: 'rzmps-benchmark-compatibility',
      enforce: 'pre',
      resolveId(id) {
        if (/(?:scripts\/benchmark|scripts|benchmarks\/lib)\/benchmark-selection\.mjs$/.test(id))
          return benchmarkControlModule;
      },
      transform(source, id) {
        if (id.replaceAll('\\', '/').endsWith('/src/pages/BenchmarkPage.jsx')) return adaptBenchmarkPage(source);
      },
    },
    browserCatalogPlugin(libraryRoot),
    react(),
  ],
  resolve: {
    alias: { '@rzmps/rzmps': path.join(libraryRoot, 'packages/rzmps/build/index.mjs') },
    dedupe: ['three', 'react', 'react-dom'],
  },
  build: {
    outDir: path.resolve(values['out-dir']),
    emptyOutDir: true,
    rollupOptions: { input: path.join(demoRoot, 'benchmark.html') },
  },
});
