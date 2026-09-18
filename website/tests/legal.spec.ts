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

const GITHUB = 'https://github.com/dinhanhthi/memlore'

async function expectSiteMenuBar(page: Page, { compact }: { compact: boolean }) {
  const header = page.locator('.site-header')
  const nav = page.getByRole('navigation', { name: 'Main navigation' })
  if (compact) {
    const toggle = page.getByRole('button', { name: 'Open menu' })
    await expect(toggle).toBeVisible()
    await expect(nav).toBeHidden()
    await toggle.click()
  }
  await expect(nav.getByRole('link', { name: 'Demo' })).toHaveAttribute('href', 'index.html#demo')
  await expect(nav.getByRole('link', { name: 'Features' })).toHaveAttribute(
    'href',
    'index.html#features',
  )
  await expect(nav.getByRole('link', { name: 'Compare' })).toHaveAttribute(
    'href',
    'index.html#compare',
  )
  await expect(nav.getByRole('link', { name: 'Changelog' })).toHaveAttribute(
    'href',
    'changelog.html',
  )
  await expect(nav.locator('summary')).toHaveText('Doc')
  await expect(header.locator('.header-github')).toBeVisible()
  await expect(header.locator('.header-github')).toHaveAttribute('href', GITHUB)
  if (compact) {
    await expect(header.locator('.header-actions .download')).toBeHidden()
    return
  }
  await expect(header.locator('.header-actions .download')).toBeVisible()
  await expect(header.locator('.header-actions .download')).toHaveAttribute('href', GITHUB)
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

for (const path of ['/privacy.html', '/terms.html', '/changelog.html'] as const) {
  test(`${path} keeps Demo, Features, Compare, Changelog, Doc, GitHub, and Download in the menu bar`, async ({
    page,
  }) => {
    await page.goto(path)
    await expectSiteMenuBar(page, { compact: false })
  })

  test(`${path} compact menu still has Demo, Features, Compare, Changelog, Doc, and GitHub`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto(path)
    await expectSiteMenuBar(page, { compact: true })
    await expectNoRootOverflow(page)
  })
}

test('homepage footer Privacy and Terms links navigate to the legal pages', async ({ page }) => {
  await page.goto('/')
  const footer = page.getByRole('contentinfo')
  await footer.getByRole('link', { name: 'Privacy' }).click()
  await expect(page).toHaveURL(/privacy\.html/)
  await expect(page).toHaveTitle('Memlore — Privacy Policy')

  await page.goto('/')
  await page.getByRole('contentinfo').getByRole('link', { name: 'Terms' }).click()
  await expect(page).toHaveURL(/terms\.html/)
  await expect(page).toHaveTitle('Memlore — Terms of Service')
})

test('legal page footers link Privacy and Terms', async ({ page }) => {
  await page.goto('/privacy.html')
  const footer = page.getByRole('contentinfo')
  await expect(footer.getByRole('link', { name: 'Privacy' })).toHaveAttribute(
    'aria-current',
    'page',
  )
  await footer.getByRole('link', { name: 'Terms' }).click()
  await expect(page).toHaveURL(/terms\.html/)
  await expect(page.getByRole('contentinfo').getByRole('link', { name: 'Terms' })).toHaveAttribute(
    'aria-current',
    'page',
  )
})

test('compact privacy.html has no root overflow', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto('/privacy.html')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expectNoRootOverflow(page)
})

// Google's OAuth verification reviewer fetches the raw HTML and does not execute
// JS. Every other test here renders through React, so only this one fails if the
// build-time prerender silently stops firing.
for (const [path, marker] of [
  ['/privacy.html', 'Limited Use'],
  ['/terms.html', 'Terms'],
  ['/index.html', 'privacy.html'],
] as const) {
  test(`${path} serves its content without JavaScript`, async ({ request }) => {
    const html = await (await request.get(path)).text()
    expect(html).toContain('<main id="main">')
    expect(html).toContain(marker)
  })
}
