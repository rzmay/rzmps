module.exports = {
  extends: ['../.eslintrc.cjs'],
  env: { node: true },
  // These files are ES modules, where block-scoped function declarations are well-defined.
  rules: { 'no-inner-declarations': 'off' },
  overrides: [
    {
      files: ['preview/**/*.{js,mjs}', 'tests/preview/**/*.{js,mjs}', 'tests/site/browser-check.mjs'],
      env: { browser: true },
      globals: { GPUBufferUsage: 'readonly', GPUMapMode: 'readonly', GPUShaderStage: 'readonly' },
    },
    { files: ['**/*.cjs'], parserOptions: { sourceType: 'script' } },
  ],
};
