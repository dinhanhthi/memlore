import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright config for web-harness E2E (mocked Tauri IPC).
 *
 * Tests run against `pnpm web:dev` on port 5175 — no live Google OAuth,
 * no Tauri binary. Install with `pnpm add -D @playwright/test` and
 * `pnpm exec playwright install chromium` if the package is missing.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    // Vite binds `localhost` (often ::1 on macOS); avoid 127.0.0.1-only URLs.
    baseURL: 'http://localhost:5175',
    trace: 'on-first-retry',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'MEMLORE_WEB_DEV_NO_OPEN=1 pnpm web:dev',
    url: 'http://localhost:5175',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
