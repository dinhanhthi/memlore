import { defineConfig } from 'vitest/config'
import { fileURLToPath, URL } from 'node:url'

// Web tests run separately from the root suite (root vite.config.ts does not include web/**).
export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  test: {
    globals: true,
    environment: 'node',
    include: ['web/**/*.test.ts', 'workers/web-auth/**/*.test.ts', 'web/**/*.wasm.test.ts'],
  },
})
