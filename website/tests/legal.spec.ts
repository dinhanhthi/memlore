import { expect, test, type Page } from '@playwright/test'

/**
 * Third-party / browser noise that is not a legal-page contract failure.
 * Same filter as landing.spec.ts — ResizeObserver loops are Chromium noise.
 */
const IGNORED_CONSOLE = [/ResizeObserver loop/i]

function attachErrorCollectors(page: Page) {
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const text = message.text()
    if (IGNORED_CONSOLE.some((pattern) => pattern.test(text))) return
    consoleErrors.push(text)
  })
  return { pageErrors, consoleErrors }
}

async function expectNoRootOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    htmlScroll: document.documentElement.scrollWidth,
    htmlClient: document.documentElement.clientWidth,
    bodyScroll: document.body.scrollWidth,
    bodyClient: document.body.clientWidth,
  }))
  expect(
    overflow.htmlScroll,
    `html overflow ${overflow.htmlScroll} > ${overflow.htmlClient}`,
  ).toBeLessThanOrEqual(overflow.htmlClient)
  expect(
    overflow.bodyScroll,
    `body overflow ${overflow.bodyScroll} > ${overflow.bodyClient}`,
  ).toBeLessThanOrEqual(overflow.bodyClient)
}

async function expectProductionScripts(page: Page) {
  const scripts = await page
    .locator('script[src]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('src') ?? ''))
  expect(scripts.some((src) => src.includes('/assets/'))).toBe(true)
  expect(scripts.every((src) => !src.includes('@vite') && !src.includes('/src/'))).toBe(true)
}

test('privacy.html loads from production assets', async ({ page }) => {
  const errors = attachErrorCollectors(page)
  await page.goto('/privacy.html')
  await expect(page).toHaveTitle('Memlore — Privacy Policy')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Privacy Policy')
  await expect(page.locator('body')).toContainText('drive.appdata')
  await expect(page.locator('body')).toContainText('Google API Services User Data Policy')
  await expect(page.locator('body')).toContainText('Limited Use')
  await expectProductionScripts(page)
  expect(errors.pageErrors, errors.pageErrors.join('\n')).toEqual([])
  expect(errors.consoleErrors, errors.consoleErrors.join('\n')).toEqual([])
})

test('terms.html loads from production assets', async ({ page }) => {
  const errors = attachErrorCollectors(page)
  await page.goto('/terms.html')
  await expect(page).toHaveTitle('Memlore — Terms of Service')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Terms of Service')
  await expect(page.locator('body')).toContainText('AGPL')
  await expectProductionScripts(page)
  expect(errors.pageErrors, errors.pageErrors.join('\n')).toEqual([])
  expect(errors.consoleErrors, errors.consoleErrors.join('\n')).toEqual([])
})

test('homepage footer Privacy and Terms links navigate to the legal pages', async ({ page }) => {
  await page.goto('/')
  const legalNav = page.getByRole('navigation', { name: 'Privacy and Terms' })
  await legalNav.getByRole('link', { name: 'Privacy' }).click()
  await expect(page).toHaveURL(/privacy\.html/)
  await expect(page).toHaveTitle('Memlore — Privacy Policy')

  await page.goto('/')
  await page
    .getByRole('navigation', { name: 'Privacy and Terms' })
    .getByRole('link', { name: 'Terms' })
    .click()
  await expect(page).toHaveURL(/terms\.html/)
  await expect(page).toHaveTitle('Memlore — Terms of Service')
})

test('compact privacy.html has no root overflow', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto('/privacy.html')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expectNoRootOverflow(page)
})
