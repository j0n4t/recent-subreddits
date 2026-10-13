import js from '@eslint/js';
import globals from 'globals';

// src/ is bundled into a userscript: the GM_* APIs are globals the browser
// extension injects, and the bundle runs as a classic script (not a module).
const userscriptGlobals = {
  GM_getValue: 'readonly',
  GM_setValue: 'readonly',
  GM_xmlhttpRequest: 'readonly',
};

export default [
  {
    ignores: ['recent-subreddits.user.js', 'node_modules/**'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...userscriptGlobals },
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    // The e2e tests carry `run(() => ...)` bodies that execute in the page, so
    // both the test process's node globals and the page's browser globals are
    // legitimately in scope here.
    files: ['tests/e2e/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    files: ['tests/unit/**/*.mjs', 'tests/manual/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
];
