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
    files: ['scripts/**/*.mjs', 'tests/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, document: 'readonly' },
    },
  },
];
