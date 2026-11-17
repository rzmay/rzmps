module.exports = {
  extends: ['../scripts/.eslintrc.cjs'],
  env: { browser: true, node: true },
  globals: { GPUBufferUsage: 'readonly', GPUMapMode: 'readonly', GPUShaderStage: 'readonly' },
};
