import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

function reactDevtoolsPlugin() {
  return {
    name: 'react-devtools',
    transformIndexHtml() {
      return [
        {
          tag: 'script',
          attrs: { src: 'http://localhost:8097' },
          injectTo: 'head-prepend' as const,
        },
      ]
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [
    tailwindcss(),
    react(),
    // Inject only when React DevTools is started (`MEMLORE_REACT_DEVTOOLS=1 pnpm tauri dev`).
    // Avoids ERR_CONNECTION_REFUSED on :8097 during normal dev.
    ...(command === 'serve' && process.env.MEMLORE_REACT_DEVTOOLS === '1'
      ? [reactDevtoolsPlugin()]
      : []),
  ],

  resolve: {
    // Deps like recharts pull react through their own pnpm virtual-store
    // symlink, resolving a second React instance and crashing hooks with
    // "Invalid hook call" (resolveDispatcher -> null). Same fix as web/vite.config.ts.
    dedupe: ['react', 'react-dom'],
  },

  // Vite options for Tauri development
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      // Tell Vite to watch the src-tauri directory for Rust changes
      ignored: ['**/src-tauri/**'],
    },
  },

  // Vitest configuration
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    include: ['src/**/*.test.{ts,tsx}', 'web/**/*.test.ts'],
  },
}))
