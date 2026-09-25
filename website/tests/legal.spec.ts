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
const DOWNLOAD = 'https://dl.memlore.app/mac'

async function expectSiteMenuBar(page: Page, { compact }: { compact: boolean }) {
  const header = page.locator('.site-header')
  const nav = page.getByRole('navigation', { name: 'Main navigation' })
  if (compact) {
    const toggle = page.getByRole('button', { name: 'Open menu' })
    await expect(toggle).toBeVisible()
    await expect(nav).toBeHidden()
    await expect(header.locator('.header-github')).toBeVisible()
    await toggle.click()
  }
  await expect(nav.getByRole('link', { name: 'Demo' })).toHaveAttribute('href', '/#demo')
  await expect(nav.getByRole('link', { name: 'Features' })).toHaveAttribute('href', '/#features')
  await expect(nav.getByRole('link', { name: 'Compare' })).toHaveAttribute('href', '/#compare')
  await expect(nav.getByRole('link', { name: 'Changelog' })).toHaveAttribute('href', '/changelog')
  await expect(nav.getByRole('link', { name: 'Docs', exact: true })).toHaveAttribute(
    'href',
    '/docs/',
  )
  await expect(header.locator('.header-github')).toHaveAttribute('href', GITHUB)
  if (compact) {
    await expect(header.locator('.header-github')).toBeVisible()
    await expect(header.locator('.header-actions .download')).toBeHidden()
    return
  }
  await expect(header.locator('.header-github')).toBeVisible()
  await expect(header.locator('.header-actions .download')).toBeVisible()
  await expect(header.locator('.header-actions .download')).toHaveAttribute('href', DOWNLOAD)
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

test('/about loads from production assets', async ({ page }) => {
  const errors = attachErrorCollectors(page)
  await page.goto('/about')
  await expect(page).toHaveTitle('Memlore — About')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('About')
  await expect(page.getByRole('main').getByRole('link', { name: 'Thi' })).toHaveAttribute(
    'href',
    'https://dinhanhthi.com',
  )
  await expectProductionScripts(page)
  expect(errors.pageErrors, errors.pageErrors.join('\n')).toEqual([])
  expect(errors.consoleErrors, errors.consoleErrors.join('\n')).toEqual([])
})

for (const path of [
  '/privacy.html',
  '/terms.html',
  '/changelog.html',
  '/about.html',
  '/privacy',
  '/terms',
  '/changelog',
  '/about',
] as const) {
  test(`${path} keeps Demo, Features, Compare, Changelog, Docs, GitHub, and Download in the menu bar`, async ({
    page,
  }) => {
    await page.goto(path)
    await expectSiteMenuBar(page, { compact: false })
  })

  test(`${path} compact menu still has Demo, Features, Compare, Changelog, Docs, and GitHub`, async ({
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
  await expect(page).toHaveURL(/\/privacy$/)
  await expect(page).toHaveTitle('Memlore — Privacy Policy')

  await page.goto('/')
  await page.getByRole('contentinfo').getByRole('link', { name: 'Terms' }).click()
  await expect(page).toHaveURL(/\/terms$/)
  await expect(page).toHaveTitle('Memlore — Terms of Service')
})

test('homepage footer About link navigates to the About page', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('contentinfo').getByRole('link', { name: 'About' }).click()
  await expect(page).toHaveURL(/\/about$/)
  await expect(page).toHaveTitle('Memlore — About')
  await expect(page.getByRole('contentinfo').getByRole('link', { name: 'About' })).toHaveAttribute(
    'aria-current',
    'page',
  )
})

test('the footer no longer credits the author', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('contentinfo')).not.toContainText(/made with/i)
})

test('the header no longer shows a version badge', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.version-badge')).toHaveCount(0)
})

test('legal page footers link Privacy and Terms', async ({ page }) => {
  await page.goto('/privacy')
  const footer = page.getByRole('contentinfo')
  await expect(footer.getByRole('link', { name: 'Privacy' })).toHaveAttribute(
    'aria-current',
    'page',
  )
  await footer.getByRole('link', { name: 'Terms' }).click()
  await expect(page).toHaveURL(/\/terms$/)
  await expect(page.getByRole('contentinfo').getByRole('link', { name: 'Terms' })).toHaveAttribute(
    'aria-current',
    'page',
  )
})

test('footer Terms link is a client-side route change, not a page load', async ({ page }) => {
  await page.goto('/privacy')
  await page.evaluate(() => {
    document.documentElement.dataset.spa = '1'
  })
  await page.getByRole('contentinfo').getByRole('link', { name: 'Terms' }).click()
  await expect(page).toHaveURL(/\/terms$/)
  await expect(page).toHaveTitle('Memlore — Terms of Service')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Terms of Service')
  expect(await page.evaluate(() => document.documentElement.dataset.spa)).toBe('1')
  // Privacy and Terms render the same component, so React reconciles in place and focus
  // would stay on the footer link — a screen reader would never hear the page changed.
  await expect(page.locator('main')).toBeFocused()

  await page.goBack()
  await expect(page).toHaveURL(/\/privacy$/)
  await expect(page).toHaveTitle('Memlore — Privacy Policy')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Privacy Policy')
  expect(await page.evaluate(() => document.documentElement.dataset.spa)).toBe('1')

  await page.goForward()
  await expect(page).toHaveTitle('Memlore — Terms of Service')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Terms of Service')
})

test('modifier-click on a nav link is left to the browser', async ({ page }) => {
  await page.goto('/privacy')
  const nav = page.getByRole('navigation', { name: 'Main navigation' })
  await nav.getByRole('link', { name: 'Changelog' }).click({ modifiers: ['ControlOrMeta'] })
  expect(await page.evaluate(() => window.location.pathname)).toBe('/privacy')
  await expect(page).toHaveTitle('Memlore — Privacy Policy')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Privacy Policy')
})

test('middle-click on a nav link is left to the browser', async ({ page }) => {
  await page.goto('/privacy')
  const nav = page.getByRole('navigation', { name: 'Main navigation' })
  await nav.getByRole('link', { name: 'Changelog' }).click({ button: 'middle' })
  expect(await page.evaluate(() => window.location.pathname)).toBe('/privacy')
  await expect(page).toHaveTitle('Memlore — Privacy Policy')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Privacy Policy')
})

test('a nav link with a hash lands on the section after the route swap', async ({ page }) => {
  await page.goto('/privacy')
  const nav = page.getByRole('navigation', { name: 'Main navigation' })
  await nav.getByRole('link', { name: 'Features' }).click()
  await expect(page).toHaveURL(/\/#features$/)
  await expect(page.locator('#features')).toBeInViewport()
})

test('privacy sits on the ledger and pins the footer to the page bottom', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/privacy')
  await expect(page.locator('main.ledger')).toHaveCount(1)
  await expect(page.locator('.section-label')).toHaveText('Legal')
  await expect(page.locator('main .ledger-rule').first()).toBeVisible()
  await expect(page.locator('footer .ledger-rule')).toHaveCount(1)
  const frame = await page.evaluate(() => {
    const root = document.getElementById('root')
    const main = document.querySelector('main')
    const footer = document.querySelector('footer')
    const rule = document.querySelector('main .ledger-rule')
    if (!root || !main || !footer || !rule) return null
    return {
      rootMin: getComputedStyle(root).minHeight,
      mainGrow: getComputedStyle(main).flexGrow,
      footerBottom: Math.round(footer.getBoundingClientRect().bottom),
      rootBottom: Math.round(root.getBoundingClientRect().bottom),
      viewH: window.innerHeight,
      ordinal: getComputedStyle(rule, '::before').content,
    }
  })
  expect(frame, 'ledger frame should exist').toBeTruthy()
  expect(parseFloat(frame!.rootMin), 'root should fill the viewport').toBeGreaterThanOrEqual(
    frame!.viewH - 1,
  )
  expect(frame!.mainGrow, 'main should grow so the footer sits at the bottom').toBe('1')
  expect(frame!.footerBottom, 'footer should sit on the root floor').toBe(frame!.rootBottom)
  expect(
    frame!.ordinal === 'none' || frame!.ordinal === '""',
    'wide privacy should paint 01 02',
  ).toBe(false)
})

test('compact /privacy has no root overflow', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto('/privacy')
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
  ['/about.html', 'made with'],
] as const) {
  test(`${path} serves its content without JavaScript`, async ({ request }) => {
    const html = await (await request.get(path)).text()
    expect(html).toContain('<main id="main">')
    expect(html).toContain(marker)
  })
}
