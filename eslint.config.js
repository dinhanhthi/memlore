import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'src-tauri']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // react-hooks v7 refs rule produces false positives with third-party
      // callback refs (floating-ui, useRef assignments in effects, etc.)
      'react-hooks/refs': 'off',
      // react-hooks v7 set-state-in-effect: fixed where possible; otherwise
      // disabled inline with a per-site reason. Most are data-fetch call sites
      // (would require adopting a data-fetching library to fix properly), the
      // rest are prop-driven resets, timer ticks and hydration races.
      'react-hooks/set-state-in-effect': 'error',
      // react-hooks v7 purity: fixed where possible; otherwise disabled inline
      // with a per-site reason. React Compiler is not enabled, so the render
      // -phase `Date.now()` these guard is advisory, not a miscompile.
      'react-hooks/purity': 'error',
    },
  },
  {
    // App entry points mount the tree and export nothing, which is exactly what
    // the rule reports ("Fast refresh only works when a file has exports").
    // Nothing imports them, so there is no refresh boundary to preserve.
    files: ['src/main.tsx', 'web/main.tsx', 'website/src/main.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
])
