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
      // react-hooks v7 set-state-in-effect: fixed where possible,
      // disabled inline at data-fetching call sites (would require
      // adopting a data-fetching library to fix properly).
      'react-hooks/set-state-in-effect': 'error',
      // react-hooks v7 purity: fixed where it triggers.
      'react-hooks/purity': 'error',
    },
  },
])
