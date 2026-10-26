import path from 'node:path';
import { parseArgs } from 'node:util';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

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
  plugins: [react()],
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
