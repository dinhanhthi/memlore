import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright config for the marketing website.
 *
 * Tests run against a production preview (`website:build` then
 * `website:preview` on port 4176). Do not point this suite at
 * `website:dev` — hashed `/assets/` URLs are part of the contract.
 *
 * Separate from the root `playwright.config.ts` web harness (port 5175).
 */
export default defineConfig({
  testDir: './tests',
  testMatch: 'landing.spec.ts',
  outputDir: './test-results',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4176',
    trace: 'on-first-retry',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'pnpm website:build && pnpm website:preview',
    url: 'http://localhost:4176',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    cwd: '..',
  },
})
