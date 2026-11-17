module.exports = {
  parser: '@typescript-eslint/parser',
  extends: ['../.eslintrc.cjs'],
  env: { node: true },
  // These files are ES modules, where block-scoped function declarations are well-defined.
  rules: { 'no-inner-declarations': 'off' },
  overrides: [
    {
      files: ['preview/**/*.{js,mjs}'],
      env: { browser: true },
      globals: { GPUBufferUsage: 'readonly', GPUMapMode: 'readonly', GPUShaderStage: 'readonly' },
    },
    { files: ['**/*.cjs'], parserOptions: { sourceType: 'script' } },
  ],
};
