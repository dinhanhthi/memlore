import { expect, test, type Page } from '@playwright/test'
import { changelog } from '../src/content'
import { releases } from '../src/changelog/changelogData'

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

async function cssVarColor(page: Page, token: string) {
  return page.evaluate((name) => {
    const probe = document.createElement('span')
    probe.style.color = `var(${name})`
    document.body.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  }, token)
}

test('changelog.html loads from production assets', async ({ page }) => {
  const errors = attachErrorCollectors(page)
  await page.goto('/changelog.html')
  await expect(page).toHaveTitle(changelog.metaTitle)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(changelog.title)
  const scripts = await page
    .locator('script[src]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('src') ?? ''))
  expect(scripts.some((src) => src.includes('/assets/'))).toBe(true)
  expect(scripts.every((src) => !src.includes('@vite') && !src.includes('/src/'))).toBe(true)
  expect(errors.pageErrors, errors.pageErrors.join('\n')).toEqual([])
  expect(errors.consoleErrors, errors.consoleErrors.join('\n')).toEqual([])
})

test('changelog menubar link is current and points at this page', async ({ page }) => {
  await page.goto('/changelog')
  const nav = page.getByRole('navigation', { name: 'Main navigation' })
  const link = nav.getByRole('link', { name: 'Changelog' })
  await expect(link).toHaveAttribute('href', '/changelog')
  await expect(link).toHaveAttribute('aria-current', 'page')
})

test('version table of contents is absent with the live release list', async ({ page }) => {
  await page.goto('/changelog')
  expect(releases.length).toBeLessThanOrEqual(4)
  await expect(page.getByRole('navigation', { name: changelog.tocAria })).toHaveCount(0)
  for (const release of releases) {
    await expect(
      page.getByRole('heading', { level: 2, name: `v${release.version}` }),
    ).toHaveAttribute('id', `v${release.version}`)
  }
})

test('changelog page paints kind badges without overflowing at desktop and compact', async ({
  page,
}, testInfo) => {
  for (const viewport of [
    { width: 1280, height: 800, name: 'desktop' },
    { width: 375, height: 812, name: 'compact' },
  ] as const) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.goto('/changelog')
    await page.screenshot({ path: testInfo.outputPath(`changelog-${viewport.name}.png`) })
    const overflow = await page.evaluate(() => ({
      htmlScroll: document.documentElement.scrollWidth,
      htmlClient: document.documentElement.clientWidth,
    }))
    expect(
      overflow.htmlScroll,
      `${viewport.name} overflow ${overflow.htmlScroll} > ${overflow.htmlClient}`,
    ).toBeLessThanOrEqual(overflow.htmlClient)
  }
})

test('kind badges use success for New and accent for Improved', async ({ page }) => {
  await page.goto('/changelog')
  const success = await cssVarColor(page, '--color-success')
  const accent = await cssVarColor(page, '--color-accent')
  const error = await cssVarColor(page, '--color-error')
  const newBadge = page.locator('.changelog-kind[data-kind="new"]').first()
  const improvedBadge = page.locator('.changelog-kind[data-kind="improved"]').first()
  await expect(newBadge).toHaveText('New')
  await expect(improvedBadge).toHaveText('Improved')
  expect(await newBadge.evaluate((el) => getComputedStyle(el).color)).toBe(success)
  expect(await improvedBadge.evaluate((el) => getComputedStyle(el).color)).toBe(accent)
  expect(success, 'New must not share Improved’s honey accent').not.toBe(accent)
  expect(error, 'Breaking red stays a distinct token').not.toBe(success)
})
