import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Every @tauri-apps/* module imported by src/ -> its web shim in web/src/tauri/.
const TAURI_SHIMS: Record<string, string> = {
  '@tauri-apps/api/core': './src/tauri/core.ts',
  '@tauri-apps/api/event': './src/tauri/event.ts',
  '@tauri-apps/api/window': './src/tauri/window.ts',
  '@tauri-apps/api/path': './src/tauri/path.ts',
  '@tauri-apps/plugin-opener': './src/tauri/plugin-opener.ts',
  '@tauri-apps/plugin-dialog': './src/tauri/plugin-dialog.ts',
  '@tauri-apps/plugin-notification': './src/tauri/plugin-notification.ts',
  '@tauri-apps/plugin-autostart': './src/tauri/plugin-autostart.ts',
}

function tauriAliasGuard() {
  return {
    name: 'tauri-alias-guard',
    resolveId(id: string) {
      if (id.startsWith('@tauri-apps/') && !(id in TAURI_SHIMS)) {
        throw new Error(
          `[web app] Unaliased @tauri-apps import: "${id}". Add a shim for it in web/src/tauri/.`,
        )
      }
    },
  }
}

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  root: here('.'),
  // Isolate from the Tauri (5173) and mockup dev servers: sharing node_modules/.vite
  // causes 504 Outdated Optimize Dep on whichever server did not trigger the last
  // re-optimization.
  cacheDir: here('../node_modules/.vite-web'),
  plugins: [tailwindcss(), react(), tauriAliasGuard()],
  define: {
    'import.meta.env.VITE_MEMLORE_PLATFORM': JSON.stringify('web'),
  },
  optimizeDeps: {
    exclude: Object.keys(TAURI_SHIMS),
    // Reached only through dynamic imports; pre-bundle up front so Vite does not
    // re-optimize mid-navigation (same reason as mockup/vite.config.ts).
    include: ['recharts', 'leaflet', 'leaflet.heat', 'leaflet.markercluster'],
  },
  resolve: {
    // web/ is a separate Vite root — without dedupe, react-i18next can resolve a
    // second React copy and hooks throw "Cannot read properties of null".
    dedupe: ['react', 'react-dom', 'react-i18next'],
    alias: {
      react: here('../node_modules/react'),
      'react-dom': here('../node_modules/react-dom'),
      'react-i18next': here('../node_modules/react-i18next'),
      ...Object.fromEntries(Object.entries(TAURI_SHIMS).map(([id, shim]) => [id, here(shim)])),
    },
  },
  server: {
    port: 5176,
    strictPort: true,
    host: true,
    // wrangler dev
    proxy: { '/api': 'http://localhost:8787' },
  },
  preview: {
    port: 4176,
    strictPort: true,
  },
  build: {
    outDir: here('./dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: here('./index.html'),
    },
  },
})
