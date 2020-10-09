module.exports = {
  'parser': 'babel-eslint',
  'env': {
    'es6': true,
    'node': true,
  },
  'extends': 'eslint:recommended',
  'parserOptions': {
    'ecmaFeatures': {
      'modules': true,
    },
  },
  'rules': {
    'indent': ['error', 2],
    'quotes': ['error', 'single'],
    'linebreak-style': ['error', 'unix'],
    'semi': ['error', 'always'],
    'no-unused-vars': 'off'
    // 'no-console': ['error', { allow: ['warn', 'error', 'debug'] }],
  },
};
