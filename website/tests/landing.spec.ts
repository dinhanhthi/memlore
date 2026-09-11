import { expect, test, type Locator, type Page } from '@playwright/test'

const VIEWPORTS = [
  { name: '320', width: 320, height: 720 },
  { name: '375', width: 375, height: 812 },
  { name: '414', width: 414, height: 896 },
  { name: '768', width: 768, height: 1024 },
  { name: '1280', width: 1280, height: 800 },
] as const

const GITHUB = 'https://github.com/dinhanhthi/memlore'
const IFRAME_TITLE = 'Interactive Memlore demo with fictional journal entries'

/**
 * Third-party / browser noise that is not a landing or demo contract failure.
 * ResizeObserver loops are a known Chromium warning from layout libraries
 * (Leaflet, TipTap). Keep this list documented and narrow.
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

function demoFrame(page: Page) {
  return page.frameLocator(`iframe[title="${IFRAME_TITLE}"]`)
}

async function waitForDemoReady(page: Page) {
  await expect(page.getByRole('button', { name: 'Reset demo' })).toBeEnabled({
    timeout: 60_000,
  })
}

async function expectSingleLine(locator: Locator, label: string) {
  await expect(locator, label).toBeVisible()
  const box = await locator.boundingBox()
  expect(box, `${label} should have a box`).toBeTruthy()
  // Nav/CTA chrome is 44–48px tall. A wrap jumps well above one line.
  expect(box!.height, `${label} wrapped to more than one line`).toBeLessThanOrEqual(64)
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

async function expectChromeSingleLine(page: Page) {
  const nav = page.getByRole('navigation', { name: 'Main navigation' })
  await expectSingleLine(nav.getByRole('link', { name: 'Demo' }), 'nav Demo')
  await expectSingleLine(nav.getByRole('link', { name: 'Features' }), 'nav Features')
  await expectSingleLine(nav.getByRole('link', { name: 'Compare' }), 'nav Compare')
  await expectSingleLine(nav.locator('summary'), 'nav Doc')
  await expectSingleLine(page.locator('.github-link'), 'header GitHub')
  await expectSingleLine(page.locator('.hero .download'), 'hero download')
  await expectSingleLine(page.locator('.hero .button'), 'hero demo')
  await expectSingleLine(page.locator('.footer-main .download'), 'footer download')
}

test('landing and demo.html load from production assets', async ({ page }) => {
  const landing = attachErrorCollectors(page)
  await page.goto('/')
  await expect(page).toHaveTitle('Memlore — Make room for your story')
  await expect(page.locator(`iframe[title="${IFRAME_TITLE}"]`)).toBeVisible()
  const landingScripts = await page
    .locator('script[src]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('src') ?? ''))
  expect(landingScripts.some((src) => src.includes('/assets/'))).toBe(true)
  expect(landingScripts.every((src) => !src.includes('@vite') && !src.includes('/src/'))).toBe(true)
  expect(landing.pageErrors, landing.pageErrors.join('\n')).toEqual([])

  await page.goto('/demo.html')
  await expect(page).toHaveTitle('Memlore — Interactive demo')
  await expect(page.locator('#root')).toBeVisible()
  const demoScripts = await page
    .locator('script[src]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('src') ?? ''))
  expect(demoScripts.some((src) => src.includes('/assets/'))).toBe(true)
  expect(demoScripts.every((src) => !src.includes('@vite') && !src.includes('/src/'))).toBe(true)
})

for (const viewport of VIEWPORTS) {
  test(`viewport ${viewport.name}: no overflow, single-line chrome, no console errors`, async ({
    page,
  }, testInfo) => {
    const errors = attachErrorCollectors(page)
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.goto('/')
    await expect(page.locator('h1')).toBeVisible()
    await expectNoRootOverflow(page)
    await expectChromeSingleLine(page)
    await page.screenshot({
      path: testInfo.outputPath(`landing-${viewport.name}.png`),
      fullPage: true,
    })
    expect(errors.pageErrors, errors.pageErrors.join('\n')).toEqual([])
    expect(errors.consoleErrors, errors.consoleErrors.join('\n')).toEqual([])
  })
}

test('CTA buttons stay fully rounded in every design system', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await waitForDemoReady(page)
  const download = page.locator('.hero .download')
  const secondary = page.locator('.hero .button')
  const picker = page.getByRole('radiogroup', { name: 'Design system for website and demo' })
  for (const name of ['Clay', 'Clean', 'Signature'] as const) {
    await picker.getByRole('radio', { name }).click()
    await expect(page.locator('html')).toHaveAttribute('data-design-system', name.toLowerCase())
    const downloadPx = await download.evaluate((el) =>
      parseFloat(getComputedStyle(el).borderRadius),
    )
    const secondaryPx = await secondary.evaluate((el) =>
      parseFloat(getComputedStyle(el).borderRadius),
    )
    expect(downloadPx, `${name} primary radius`).toBe(9999)
    expect(secondaryPx, `${name} secondary radius`).toBe(9999)
  }
})

test('editor media pane shows file-type icons instead of body copy', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  const pane = page.locator('.ed-media')
  await expect(pane).toBeVisible()
  await expect(pane.locator('small')).toHaveText('Media')
  await expect(pane.locator('p')).toHaveCount(0)
  await expect(pane.locator('.ed-files svg')).toHaveCount(3)
  await expect(pane).not.toContainText('Photos, video, and voice memos')
})

test('demo Settings design system syncs landing data-design-system', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await waitForDemoReady(page)
  const html = page.locator('html')
  const frame = demoFrame(page)

  await frame.getByRole('button', { name: 'Settings' }).first().click()
  await frame.getByRole('tab', { name: 'Appearance' }).click()
  const systems = [
    { name: 'Clean design system', id: 'clean' },
    { name: 'Switch to the Clay design system', id: 'clay' },
    { name: 'Signature design system', id: 'signature' },
  ] as const
  for (const system of systems) {
    await frame.getByRole('radio', { name: system.name }).click()
    await expect(html).toHaveAttribute('data-design-system', system.id)
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme))
      .toBe('dark')
    await expect
      .poll(() => page.evaluate(() => document.documentElement.style.colorScheme))
      .toBe('dark')
  }
})

test('theme selector syncs landing data-design-system and demo ds-* class', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await waitForDemoReady(page)
  const html = page.locator('html')
  const frameHtml = demoFrame(page).locator('html')
  const picker = page.getByRole('radiogroup', { name: 'Design system for website and demo' })

  for (const system of [
    { id: 'clay', name: 'Clay' },
    { id: 'clean', name: 'Clean' },
    { id: 'signature', name: 'Signature' },
  ] as const) {
    await picker.getByRole('radio', { name: system.name }).click()
    await expect(html).toHaveAttribute('data-design-system', system.id)
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme))
      .toBe('dark')
    await expect
      .poll(() => page.evaluate(() => document.documentElement.style.colorScheme))
      .toBe('dark')
    await expect(frameHtml).toHaveClass(new RegExp(`\\bds-${system.id}\\b`))
  }
})

test('guided demo actions navigate the iframe and reset restores write', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await waitForDemoReady(page)
  const frame = demoFrame(page)

  await page.getByRole('button', { name: 'Write a little' }).click()
  await expect(page.getByRole('button', { name: 'Write a little' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(frame.getByText('A fresh start').first()).toBeVisible({ timeout: 20_000 })

  await page.getByRole('button', { name: 'Look back' }).click()
  await expect(page.getByRole('button', { name: 'Look back' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(frame.getByRole('heading', { name: 'Statistics' })).toBeVisible({ timeout: 20_000 })

  await page.getByRole('button', { name: 'Ask your journal' }).click()
  await expect(page.getByRole('button', { name: 'Ask your journal' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(
    frame.getByRole('heading', { name: 'Daily Chat' }).or(frame.getByText('Conversations')),
  ).toBeVisible({ timeout: 20_000 })

  await page.getByRole('button', { name: 'Keep it private' }).click()
  await expect(page.getByRole('button', { name: 'Keep it private' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(frame.getByText('Second lock', { exact: false }).first()).toBeVisible({
    timeout: 20_000,
  })

  await page.getByRole('button', { name: 'Reset demo' }).click()
  await waitForDemoReady(page)
  await expect(page.getByRole('button', { name: 'Write a little' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(frame.getByText('A fresh start').first()).toBeVisible({ timeout: 20_000 })
})

test('demo disclaimer, doc disclosure, GitHub href, and beta download', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.demo-disclaimer')).toContainText(/sample data/i)
  await expect(page.locator('.demo-disclaimer')).toContainText(/simulated/i)

  const doc = page.locator('details.doc-menu')
  await expect(doc.locator('summary')).toHaveText('Doc')
  await expect(doc.locator('summary')).not.toHaveAttribute('href', /.*/)
  await doc.locator('summary').click()
  await expect(doc).toHaveAttribute('open', '')
  await expect(doc).toContainText(/coming soon/i)
  await expect(doc.locator('a[href*="404"]')).toHaveCount(0)

  await expect(page.locator('.github-link')).toHaveAttribute('href', GITHUB)
  const download = page.locator('.hero .download')
  await expect(download).toHaveAttribute('href', GITHUB)
  await expect(download).toHaveAttribute('aria-label', /macOS beta from GitHub/i)
  await expect(page.getByRole('link', { name: /app store|play store/i })).toHaveCount(0)
  await expect(page.locator('.site-header')).toHaveCSS('position', 'sticky')
})

test('lock UI exists and chat composer is reachable after guided navigation', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await waitForDemoReady(page)
  const frame = demoFrame(page)

  await page.getByRole('button', { name: 'Keep it private' }).click()
  await expect(
    frame.getByRole('button', { name: /change password|unlock|disable second lock/i }).first(),
  ).toBeVisible({
    timeout: 20_000,
  })

  await page.getByRole('button', { name: 'Ask your journal' }).click()
  const newChat = frame.getByRole('button', { name: /^New( chat)?$/i }).first()
  await expect(newChat).toBeEnabled({ timeout: 20_000 })
  const composer = frame.getByPlaceholder('Tell me about your day…')
  if ((await composer.count()) === 0) {
    await newChat.click()
  }
  await expect(composer).toBeVisible({ timeout: 20_000 })
  await composer.fill('What did I write this week?')
  await frame.getByRole('button', { name: 'Send' }).click()
  // Token-by-token completion is covered by website/tests/scenario.test.ts.
  // In the iframe, the composer disables and Stop appears as soon as the
  // simulated stream starts — that is the E2E contract.
  await expect(frame.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 15_000 })
})
