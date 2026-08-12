export default [
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        browser: 'readonly',
        Node: 'readonly',
        DOMParser: 'readonly',
        XMLSerializer: 'readonly',
        HTMLElement: 'readonly',
        Blob: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        alert: 'readonly',
        globalThis: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'warn',
      'no-console': 'off',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'web-ext-artifacts/**', 'tools/**', 'tests/**'],
  },
];
