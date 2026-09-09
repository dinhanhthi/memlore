import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const ALIASED_TAURI = new Set([
  '@tauri-apps/api/core',
  '@tauri-apps/api/event',
  '@tauri-apps/api/window',
  '@tauri-apps/api/path',
  '@tauri-apps/plugin-opener',
  '@tauri-apps/plugin-dialog',
  '@tauri-apps/plugin-notification',
])

function tauriAliasGuard() {
  return {
    name: 'tauri-alias-guard',
    resolveId(id: string) {
      if (id.startsWith('@tauri-apps/') && !ALIASED_TAURI.has(id)) {
        throw new Error(
          `[web harness] Unaliased @tauri-apps import: "${id}". Add a mock for it in web/mocks/.`,
        )
      }
    },
  }
}

const TAURI_MOCK_IDS = [...ALIASED_TAURI]

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  // Isolate from the Tauri dev server (port 5173). Both configs alias/pre-bundle
  // differently; sharing node_modules/.vite causes 504 Outdated Optimize Dep on
  // whichever server did not trigger the last re-optimization.
  cacheDir: fileURLToPath(new URL('../node_modules/.vite-web', import.meta.url)),
  base: './',
  publicDir: fileURLToPath(new URL('../public', import.meta.url)),
  plugins: [tailwindcss(), react(), tauriAliasGuard()],
  optimizeDeps: {
    exclude: TAURI_MOCK_IDS,
    // These heavy deps are reached only through dynamic imports (the lazy stats
    // charts and map views). Left undiscovered at startup, Vite re-optimizes and
    // full-reloads the first time you navigate there, which aborts the in-flight
    // dynamic import with "Failed to fetch dynamically imported module". Pre-bundle
    // them up front so no mid-navigation re-optimization happens.
    include: ['recharts', 'leaflet', 'leaflet.heat', 'leaflet.markercluster'],
  },
  resolve: {
    // web/ is a separate Vite root — without dedupe, react-i18next can resolve a
    // second React copy and hooks throw "Cannot read properties of null
    // (reading 'useSyncExternalStore')".
    dedupe: ['react', 'react-dom', 'react-i18next'],
    alias: {
      react: fileURLToPath(new URL('../node_modules/react', import.meta.url)),
      'react-dom': fileURLToPath(new URL('../node_modules/react-dom', import.meta.url)),
      'react-i18next': fileURLToPath(new URL('../node_modules/react-i18next', import.meta.url)),
      '@tauri-apps/api/core': fileURLToPath(new URL('./mocks/core.ts', import.meta.url)),
      '@tauri-apps/api/event': fileURLToPath(new URL('./mocks/event.ts', import.meta.url)),
      '@tauri-apps/api/window': fileURLToPath(new URL('./mocks/window.ts', import.meta.url)),
      '@tauri-apps/api/path': fileURLToPath(new URL('./mocks/path.ts', import.meta.url)),
      '@tauri-apps/plugin-opener': fileURLToPath(
        new URL('./mocks/plugin-opener.ts', import.meta.url),
      ),
      '@tauri-apps/plugin-dialog': fileURLToPath(
        new URL('./mocks/plugin-dialog.ts', import.meta.url),
      ),
      '@tauri-apps/plugin-notification': fileURLToPath(
        new URL('./mocks/plugin-notification.ts', import.meta.url),
      ),
    },
  },
  server: {
    port: 5175,
    strictPort: true,
    host: true,
  },
  preview: {
    port: 4175,
    strictPort: true,
  },
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      input: fileURLToPath(new URL('./index.html', import.meta.url)),
    },
  },
})
