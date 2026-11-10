module.exports = {
  root: true,
  extends: ['eslint:recommended'],
  env: { es2022: true },
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  overrides: [{ files: ['**/*.ts', '**/*.tsx'], rules: { 'no-undef': 'off' } }],
  rules: {
    'max-len': ['warn', { code: 120 }],
    quotes: ['error', 'single', { avoidEscape: true }],
    'jsx-quotes': ['error', 'prefer-double'],
    'no-param-reassign': ['error', { props: false }],
    'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true }],
  },
};
