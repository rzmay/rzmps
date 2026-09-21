import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rzmpsBuild = path.resolve(__dirname, '../rzmps/build/index.mjs');

export default defineConfig({
  plugins: [
    react({
      include: '**/*.{jsx,tsx}',
    }),
  ],
  resolve: {
    alias: {
      '@rzmps/rzmps': rzmpsBuild,
    },
  },
  server: {
    watch: {
      ignored: [
        '!**/packages/rzmps/build/**',
      ],
    },
  },
  optimizeDeps: {
    exclude: [
      '@rzmps/rzmps',
    ],
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  assetsInclude: [
    '**/*.hdr',
    '**/*.wasm',
  ],
});
