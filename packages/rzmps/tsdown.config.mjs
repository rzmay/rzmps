import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'build',
  format: ['esm', 'cjs'],
  dts: false,
  platform: 'neutral',
  fixedExtension: true,
  target: 'es2015',
  clean: true,
  loader: {
    '.frag': 'text',
    '.vert': 'text',
    '.png': 'dataurl',
    '.jpg': 'dataurl',
    '.jpeg': 'dataurl',
  },
});
