import path from 'node:path';
import { parseArgs } from 'node:util';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

const root = path.resolve(import.meta.dirname, '../../..');
const { values } = parseArgs({ options: {
  'library-root': { type: 'string', default: root },
  'out-dir': { type: 'string', default: path.join(root, 'apps/demo/benchmark-dist') },
} });

// Both revisions use this entry, workload, frontend dependencies, and build tool.
// Only the built RZMPS library changes; historical demo/docs builds are irrelevant.
await build({
  configFile: false,
  root: path.join(root, 'apps/demo'),
  plugins: [react()],
  resolve: {
    alias: { '@rzmps/rzmps': path.resolve(values['library-root'], 'packages/rzmps/build/index.mjs') },
    dedupe: ['three', 'react', 'react-dom'],
  },
  build: {
    outDir: path.resolve(values['out-dir']),
    emptyOutDir: true,
    rollupOptions: { input: path.join(root, 'apps/demo/benchmark.html') },
  },
});
