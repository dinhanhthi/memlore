import { expect, test, type Page } from '@playwright/test'
import { releaseAnchorId, releases } from '../src/changelog/changelogData'

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
  await expect(page).toHaveTitle('Memlore — Changelog')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('What’s new')
  const scripts = await page
    .locator('script[src]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('src') ?? ''))
  expect(scripts.some((src) => src.includes('/assets/'))).toBe(true)
  expect(scripts.every((src) => !src.includes('@vite') && !src.includes('/src/'))).toBe(true)
  expect(errors.pageErrors, errors.pageErrors.join('\n')).toEqual([])
  expect(errors.consoleErrors, errors.consoleErrors.join('\n')).toEqual([])
})

test('changelog sits on the ledger with a ruled footer', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/changelog')
  await expect(page.locator('main.ledger')).toHaveCount(1)
  await expect(page.locator('.section-label')).toHaveText('Changelog')
  await expect(page.locator('footer .ledger-rule')).toHaveCount(1)
})

test('changelog menubar link is current and points at this page', async ({ page }) => {
  await page.goto('/changelog')
  const nav = page.getByRole('navigation', { name: 'Main navigation' })
  const link = nav.getByRole('link', { name: 'Changelog' })
  await expect(link).toHaveAttribute('href', '/changelog')
  await expect(link).toHaveAttribute('aria-current', 'page')
})

test('version table of contents sits in the right rail on desktop and hides on compact', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/changelog')
  const toc = page.getByRole('navigation', { name: 'Release versions' })
  const article = page.locator('.changelog-article')
  await expect(toc).toBeVisible()
  const [articleBox, tocBox] = await Promise.all([article.boundingBox(), toc.boundingBox()])
  expect(articleBox, 'article box').toBeTruthy()
  expect(tocBox, 'toc box').toBeTruthy()
  expect(tocBox!.x).toBeGreaterThan(articleBox!.x + articleBox!.width - 2)
  const rail = await page.evaluate(() => {
    const articleEl = document.querySelector('.changelog-article')
    const tocEl = document.querySelector('.changelog-toc')
    if (!articleEl || !tocEl) return null
    const articleStyle = getComputedStyle(articleEl)
    const tocStyle = getComputedStyle(tocEl)
    const title = document.querySelector('.changelog-toc-title')
    const titleStyle = title ? getComputedStyle(title) : null
    return {
      articleRule: articleStyle.borderInlineEndWidth,
      articleClip: articleStyle.clipPath,
      tocGap: tocStyle.rowGap || tocStyle.gap,
      titlePaddingTop: titleStyle?.paddingTop ?? '',
      titlePaddingBottom: titleStyle?.paddingBottom ?? '',
      titleAlign: titleStyle?.alignItems ?? '',
    }
  })
  expect(rail, 'changelog rail styles').toBeTruthy()
  expect(parseFloat(rail!.articleRule)).toBeGreaterThan(0)
  expect(rail!.articleClip).toMatch(/inset/i)
  expect(parseFloat(rail!.tocGap)).toBeGreaterThan(0)
  expect(rail!.titlePaddingTop).toBe(rail!.titlePaddingBottom)
  expect(parseFloat(rail!.titlePaddingTop)).toBeLessThan(14)
  expect(rail!.titleAlign).toBe('center')
  for (const release of releases) {
    await expect(toc.getByRole('link', { name: `v${release.version}` })).toHaveAttribute(
      'href',
      `#v${release.version}`,
    )
    await expect(
      page.getByRole('heading', { level: 2, name: `v${release.version}` }),
    ).toHaveAttribute('id', `v${release.version}`)
  }

  await page.setViewportSize({ width: 375, height: 812 })
  await expect(toc).toBeHidden()
})

test('TOC highlights the version section in view', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/changelog')
  const toc = page.getByRole('navigation', { name: 'Release versions' })
  const first = releases[0]
  const last = releases[releases.length - 1]
  await expect(toc.getByRole('link', { name: `v${first.version}` })).toHaveAttribute(
    'aria-current',
    'true',
  )

  await page.locator(`[id="${releaseAnchorId(last.version)}"]`).evaluate((el) => {
    el.scrollIntoView({ block: 'start' })
  })
  await expect(toc.getByRole('link', { name: `v${last.version}` })).toHaveAttribute(
    'aria-current',
    'true',
  )
  await expect(toc.getByRole('link', { name: `v${first.version}` })).not.toHaveAttribute(
    'aria-current',
    'true',
  )
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
