import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
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

// Files only the web app ships. They live in web/static/, not in `publicDir`: that points at the
// repo-root `public/` (the logos and stickers src/ references), which the Tauri app bundles too.
const WEB_ONLY_FILES = ['_headers', 'boot.js'] as const

/** The `/*` block of web/static/_headers (CSP and friends), so `web:preview` serves what Pages serves. */
function productionHeaders(): Record<string, string> {
  const headers: Record<string, string> = {}
  let inGlobalBlock = false
  for (const line of readFileSync(here('./static/_headers'), 'utf8').split('\n')) {
    if (!line.startsWith(' ') && line.trim() !== '') inGlobalBlock = line.trim() === '/*'
    const match = /^\s+([A-Za-z-]+):\s*(.+)$/.exec(line)
    if (inGlobalBlock && match) headers[match[1]] = match[2].trim()
  }
  return headers
}

function webOnlyFiles(): Plugin {
  const read = (name: string) => readFileSync(here(`./static/${name}`))
  return {
    name: 'web-only-files',
    configureServer(server) {
      server.middlewares.use('/boot.js', (_req, res) => {
        res.setHeader('Content-Type', 'text/javascript')
        res.end(read('boot.js'))
      })
    },
    generateBundle() {
      for (const name of WEB_ONLY_FILES) {
        this.emitFile({ type: 'asset', fileName: name, source: read(name) })
      }
    },
  }
}

export default defineConfig({
  root: here('.'),
  publicDir: here('../public'),
  // Isolate from the Tauri (5173) and mockup dev servers: sharing node_modules/.vite
  // causes 504 Outdated Optimize Dep on whichever server did not trigger the last
  // re-optimization.
  cacheDir: here('../node_modules/.vite-web'),
  plugins: [tailwindcss(), react(), tauriAliasGuard(), webOnlyFiles()],
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
  // `pnpm web:build && pnpm web:preview` is the production-like local run: the built bundle, the
  // production headers, and the local Worker (`pnpm web-auth:dev`) on the same origin under /api.
  // Port 5176 because the Google OAuth client and the Worker's dev APP_ORIGIN allow only that origin.
  preview: {
    port: 5176,
    strictPort: true,
    proxy: { '/api': 'http://localhost:8787' },
    headers: productionHeaders(),
  },
  build: {
    outDir: here('./dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: here('./index.html'),
    },
  },
})
