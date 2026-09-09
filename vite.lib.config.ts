import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// Vite lib build for the design system barrel.
// Produces dist-lib/index.js (ES module) + dist-lib/style.css (compiled Tailwind).
// Used by the design-sync converter via --entry ./dist-lib/index.js.
//
// Aliases: use-sync-external-store is CJS-only. Without the alias, rolldown
// emits a CJS-compat wrapper with require('react') that the esbuild IIFE
// converts to __require('react'), breaking browser rendering.
// React 19 ships useSyncExternalStore natively, so the CJS shim is unnecessary.
export default defineConfig({
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      'use-sync-external-store/shim': path.resolve('src/ds-use-sync-shim.ts'),
      'use-sync-external-store': path.resolve('src/ds-use-sync-shim.ts'),
    },
  },
  build: {
    lib: {
      entry: 'src/ds-entry.ts',
      name: 'memlore',
      formats: ['es'],
      fileName: 'index',
    },
    outDir: 'dist-lib',
    emptyOutDir: true,
    rollupOptions: {
      external: ['react', 'react-dom', 'react/jsx-runtime'],
      output: {
        assetFileNames: 'style[extname]',
      },
    },
  },
})
