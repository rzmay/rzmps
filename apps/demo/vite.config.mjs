import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const localPackages = {
  '@rzmps/rzmps': path.resolve(__dirname, '../../packages/rzmps/build/index.mjs'),
  '@rzmps/ammo': path.resolve(__dirname, '../../packages/ammo/build/index.mjs'),
  '@rzmps/jolt': path.resolve(__dirname, '../../packages/jolt/build/index.mjs'),
  '@rzmps/rapier': path.resolve(__dirname, '../../packages/rapier/build/index.mjs'),
};
const localPackageAliases = Object.fromEntries(
  Object.entries(localPackages).filter(([, entry]) => fs.existsSync(entry)),
);
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
    alias: localPackageAliases,
  },
  server: {
    watch: {
      ignored: [
        '!**/packages/rzmps/build/**',
        '!**/packages/ammo/build/**',
        '!**/packages/jolt/build/**',
        '!**/packages/rapier/build/**',
      ],
    },
  },
  optimizeDeps: {
    include: [
      'three/addons/lighting/LightProbeGrid.js',
      'three/addons/lighting/LightProbeGridWebGL.js',
      'three/addons/helpers/LightProbeGridHelper.js',
      'three/addons/helpers/LightProbeGridHelperWebGL.js',
    ],
    exclude: [
      '@rzmps/rzmps',
      '@rzmps/ammo',
      '@rzmps/jolt',
      '@rzmps/rapier',
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
