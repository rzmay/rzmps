module.exports = {
  ignorePatterns: ['output/**'],
  extends: ['../scripts/.eslintrc.cjs'],
  overrides: [{ files: ['browser.mjs'], env: { browser: true } }],
};
