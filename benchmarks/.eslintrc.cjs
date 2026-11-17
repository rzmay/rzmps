module.exports = {
  ignorePatterns: ['output/**', 'node_modules/**'],
  extends: ['../scripts/.eslintrc.cjs'],
  overrides: [{ files: ['browser.mjs'], env: { browser: true } }],
};
