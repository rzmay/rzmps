import path from 'node:path';
import { parseArgs } from 'node:util';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { adaptBenchmarkPage, benchmarkControlModule } from '../../../scripts/benchmark/benchmark-adapter.mjs';

const root = path.resolve(import.meta.dirname, '../../..');
const { values } = parseArgs({ options: {
  'library-root': { type: 'string', default: root },
  'out-dir': { type: 'string', default: path.join(root, 'apps/demo/benchmark-dist') },
} });
const libraryRoot = path.resolve(values['library-root']);
const demoRoot = path.join(libraryRoot, 'apps/demo');

// Build each revision's benchmark page against its matching library. This lets
// branches add or remove API-dependent cases without breaking the other build.
await build({
  configFile: false,
  root: demoRoot,
  plugins: [{ name: 'rzmps-benchmark-compatibility', enforce: 'pre',
    resolveId(id) { if (id.endsWith('/scripts/benchmark/benchmark-selection.mjs') || id.endsWith('/scripts/benchmark-selection.mjs')) return benchmarkControlModule; },
    transform(source, id) {
      if (id.replaceAll('\\', '/').endsWith('/src/pages/BenchmarkPage.jsx')) return adaptBenchmarkPage(source);
    },
  }, react()],
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
