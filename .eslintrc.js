module.exports = {
  'env': {
    'es6': true,
    'node': true,
    'mocha': true,
  },
  'extends': 'eslint:recommended',
  'parserOptions': {
    'ecmaFeatures': {
      'jsx': true,
      'modules': true,
    },
    'ecmaVersion': '2020',
  },
  rules: {
    'no-var': 'warn',
    'eqeqeq': 'warn',
    'keyword-spacing': 'error',
    'handle-callback-err': 'error',
    'no-console': 0,
    'linebreak-style': 0,
    'react/no-unescaped-entities': 0,
    'quotes': [ 'error', 'single', { avoidEscape: true, allowTemplateLiterals: true } ],
    'semi': ['error', 'always'],
    'semi-spacing': 'error',
    'spaced-comment': 0,
    'vue/multi-word-component-names': 'off',
    'comma-dangle': ['warn', 'always-multiline'],
    'no-unused-vars': [
      'warn',
      { vars: 'all', args: 'all', argsIgnorePattern: '^_|this', ignoreRestSiblings: false },
    ],
  },
};
