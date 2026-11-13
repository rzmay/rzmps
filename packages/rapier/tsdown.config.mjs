import { defineConfig } from 'tsdown';

export default defineConfig(({ watch }) => ({
  entry: ['src/index.ts'],
  outDir: 'build',
  format: ['esm', 'cjs'],
  dts: false,
  platform: 'neutral',
  fixedExtension: true,
  target: 'es2015',
  // The declaration watcher shares this directory; only one-shot builds may clean it.
  clean: !watch,
}));
