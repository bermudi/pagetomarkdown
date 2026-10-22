import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Browser code: the globals are listed explicitly (add new ones there).
    files: ['src/**/*.js'],
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
        PointerEvent: 'readonly',
        MouseEvent: 'readonly',
        KeyboardEvent: 'readonly',
        CustomEvent: 'readonly',
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
    files: ['src/**/*.ts'],
    extends: [...tseslint.configs.recommended],
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
        PointerEvent: 'readonly',
        MouseEvent: 'readonly',
        KeyboardEvent: 'readonly',
        CustomEvent: 'readonly',
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
      // The type checker does this job now.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
    },
  },
  {
    // Test files run in Node, not in the browser.
    files: ['src/**/*.test.ts', 'src/**/*.test.js'],
    languageOptions: {
      globals: {
        process: 'readonly',
        Buffer: 'readonly',
      },
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'web-ext-artifacts/**', 'tools/**', 'tests/**'],
  },
);
