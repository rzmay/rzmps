import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const rzmpsBuild = path.resolve(__dirname, '../rzmps/build/index.mjs');
const localRzmpsAlias = fs.existsSync(rzmpsBuild)
  ? { '@rzmps/rzmps': rzmpsBuild }
  : {};
const rzmpsPackageJson = JSON.parse(
  fs.readFileSync(require.resolve('@rzmps/rzmps/package.json'), 'utf8'),
);

export default defineConfig({
  plugins: [
    react({
      include: '**/*.{jsx,tsx}',
    }),
  ],
  define: {
    'import.meta.env.VITE_RZMPS_VERSION': JSON.stringify(rzmpsPackageJson.version),
  },
  resolve: {
    alias: localRzmpsAlias,
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
