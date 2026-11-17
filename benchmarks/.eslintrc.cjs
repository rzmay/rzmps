module.exports = {
  extends: ['../scripts/.eslintrc.cjs'],
  overrides: [{ files: ['browser.mjs'], env: { browser: true } }],
};
