module.exports = {
  extends: ['../.eslintrc.cjs'],
  env: { browser: true },
  overrides: [{ files: ['*.cjs'], env: { node: true } }],
};
