import { expect, test, type Locator, type Page } from '@playwright/test'
import { latestStableRelease } from '../src/changelog/changelogData'

const VIEWPORTS = [
  { name: '320', width: 320, height: 720 },
  { name: '375', width: 375, height: 812 },
  { name: '414', width: 414, height: 896 },
  { name: '768', width: 768, height: 1024 },
  { name: '1280', width: 1280, height: 800 },
] as const

const COMPACT_MAX_PX = 1088

const GITHUB = 'https://github.com/dinhanhthi/memlore'
const LICENSE = `${GITHUB}?tab=AGPL-3.0-1-ov-file`
// The Download buttons go through the counting Worker, which then redirects to
// the GitHub asset — see workers/stats/ and website/src/links.ts.
const DOWNLOAD = 'https://dl.memlore.app/mac'
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

async function useLightLanding(page: Page) {
  await page.emulateMedia({ colorScheme: 'light' })
}

async function startDemo(page: Page) {
  const start = page.getByRole('button', { name: 'Start the demo' })
  await expect(start).toBeVisible()
  await expect(page.locator(`iframe[title="${IFRAME_TITLE}"]`)).toHaveCount(0)
  await start.click()
  await expect(page.locator('.demo-progress')).toBeVisible({ timeout: 2000 })
  await expect(page.locator(`iframe[title="${IFRAME_TITLE}"]`)).toBeVisible()
}

async function waitForDemoReady(page: Page) {
  await startDemo(page)
  await expect(page.getByRole('radio', { name: 'Clay' })).toBeEnabled({
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

async function expectChromeSingleLine(page: Page, compact: boolean) {
  await expectSingleLine(page.locator('.hero .download'), 'hero download')
  await expectSingleLine(page.locator('.hero .button'), 'hero demo')
  await expectSingleLine(page.locator('.footer-main .download'), 'footer download')
  await expectSingleLine(page.locator('.header-github'), 'header GitHub')
  if (compact) {
    const toggle = page.getByRole('button', { name: 'Open menu' })
    await expectSingleLine(toggle, 'nav toggle')
    await expect(page.locator('.header-actions .download')).toBeHidden()
    await expect(page.locator('.hero-head img')).toHaveAttribute('src', /straight\.png/)
    await toggle.click()
    const nav = page.getByRole('navigation', { name: 'Main navigation' })
    await expectSingleLine(nav.getByRole('link', { name: 'Demo' }), 'nav Demo')
    await expectSingleLine(nav.getByRole('link', { name: 'Features' }), 'nav Features')
    await expectSingleLine(nav.getByRole('link', { name: 'Compare' }), 'nav Compare')
    await expectSingleLine(nav.getByRole('link', { name: 'Changelog' }), 'nav Changelog')
    await expectSingleLine(nav.locator('summary'), 'nav Doc')
    await expectSingleLine(
      nav.getByRole('link', { name: 'Download the beta from GitHub' }),
      'nav download',
    )
    await expect(nav.getByRole('link', { name: 'GitHub', exact: true })).toHaveCount(0)
    return
  }
  const nav = page.getByRole('navigation', { name: 'Main navigation' })
  await expectSingleLine(nav.getByRole('link', { name: 'Demo' }), 'nav Demo')
  await expectSingleLine(nav.getByRole('link', { name: 'Features' }), 'nav Features')
  await expectSingleLine(nav.getByRole('link', { name: 'Compare' }), 'nav Compare')
  await expectSingleLine(nav.getByRole('link', { name: 'Changelog' }), 'nav Changelog')
  await expect(nav.getByRole('link', { name: 'Changelog' })).toHaveAttribute('href', '/changelog')
  await expectSingleLine(nav.locator('summary'), 'nav Doc')
  await expectSingleLine(page.locator('.header-actions .download'), 'header download')
  await expect(page.getByRole('button', { name: 'Open menu' })).toHaveCount(0)
}

function formatLedgerDate(isoDate: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(`${isoDate}T00:00:00Z`))
}

test('spec strip sits above the demo and links the AGPL license', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  const following = await page.evaluate(() => {
    const spec = document.querySelector('.spec-strip')
    const demo = document.querySelector('#demo')
    if (!spec || !demo) return false
    return Boolean(spec.compareDocumentPosition(demo) & Node.DOCUMENT_POSITION_FOLLOWING)
  })
  expect(following, 'spec strip should come before the demo').toBe(true)
  await expect(
    page.locator('.spec-strip').getByRole('link', { name: /read the source/i }),
  ).toHaveAttribute('href', LICENSE)
  await expect(page.locator('.spec-item', { hasText: 'version' })).toContainText(
    `v${latestStableRelease.version}`,
    { ignoreCase: true },
  )
  await expect(page.locator('.spec-item', { hasText: 'size' })).toContainText('180 MB')
})

test('hero-lead sits above the mascot on compact viewports', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  const leadBox = await page.locator('.hero-lead').boundingBox()
  const portraitBox = await page.locator('.hero-portrait').boundingBox()
  expect(leadBox, 'hero-lead should have a box').toBeTruthy()
  expect(portraitBox, 'hero portrait should have a box').toBeTruthy()
  expect(leadBox!.y + leadBox!.height, 'empty row should sit above the dog').toBeLessThanOrEqual(
    portraitBox!.y + 1,
  )
  const hairlineBetween = await page.evaluate(() => {
    const lead = document.querySelector('.hero-lead')
    const portrait = document.querySelector('.hero-portrait')
    if (!(lead instanceof HTMLElement) || !(portrait instanceof HTMLElement)) {
      return false
    }
    const leadRect = lead.getBoundingClientRect()
    const portraitRect = portrait.getBoundingClientRect()
    return [...document.querySelectorAll('.hero .ledger-rule')].some((rule) => {
      const rect = rule.getBoundingClientRect()
      return rect.top >= leadRect.bottom - 2 && rect.bottom <= portraitRect.top + 2
    })
  })
  expect(hairlineBetween, 'a hairline should sit between the empty row and the dog').toBe(true)
})

test('hero eyebrow lists the latest release with Open source as plain text', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  const eyebrow = page.locator('.hero-eyebrow')
  await expect(page.locator('.hero-lead')).toHaveCount(1)
  const accentOnEyebrowRule = await page.evaluate(() => {
    const eyebrow = document.querySelector('.hero-eyebrow')
    const rule = eyebrow?.previousElementSibling
    return rule instanceof HTMLElement && rule.hasAttribute('data-accent')
  })
  expect(accentOnEyebrowRule, 'gold dash should sit on the rule above the release line').toBe(true)
  await expect(eyebrow).toContainText('Memlore')
  await expect(eyebrow).toContainText(`v${latestStableRelease.version}`, { ignoreCase: true })
  await expect(eyebrow).toContainText(formatLedgerDate(latestStableRelease.date), {
    ignoreCase: true,
  })
  await expect(eyebrow.getByRole('link', { name: 'Open source' })).toHaveCount(0)
  await expect(eyebrow).toContainText('Open source')
  await expect(eyebrow.locator('.hero-eyebrow-version')).toHaveText(
    `v${latestStableRelease.version}`,
    { ignoreCase: true },
  )
  await expect(eyebrow.locator('.hero-eyebrow-free')).toHaveText('Free')
  const colors = await page.evaluate(() => {
    const token = (name: string) => {
      const probe = document.createElement('span')
      probe.style.color = `var(${name})`
      document.body.append(probe)
      const color = getComputedStyle(probe).color
      probe.remove()
      return color
    }
    const eyebrow = document.querySelector('.hero-eyebrow')
    const version = document.querySelector('.hero-eyebrow-version')
    const free = document.querySelector('.hero-eyebrow-free')
    return {
      muted: token('--color-muted'),
      accent: token('--color-accent'),
      success: token('--color-success'),
      eyebrow: eyebrow ? getComputedStyle(eyebrow).color : '',
      version: version ? getComputedStyle(version).color : '',
      free: free ? getComputedStyle(free).color : '',
    }
  })
  expect(colors.eyebrow, 'eyebrow should be muted').toBe(colors.muted)
  expect(colors.version, 'version should stay gold').toBe(colors.accent)
  expect(colors.free, 'Free should stay green').toBe(colors.success)
})

test('landing and demo.html load from production assets', async ({ page }) => {
  const landing = attachErrorCollectors(page)
  await page.goto('/')
  await expect(page).toHaveTitle('Memlore — A little life. A lasting story.')
  await startDemo(page)
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
    const compact = viewport.width <= COMPACT_MAX_PX
    if (compact) {
      await expect(page.locator(`iframe[title="${IFRAME_TITLE}"]`)).toHaveCount(0)
      await expect(page.locator('.demo-placeholder')).toBeVisible()
      await expect(page.getByText('This preview needs a wider window.')).toBeVisible()
      await expect(page.locator('.comparison-cards article')).toHaveCount(4)
      await expect(page.locator('.comparison-scroll')).toBeHidden()
      const demoBottom = await page
        .locator('.demo-section')
        .evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom))
      const featuresTop = await page
        .locator('#features')
        .evaluate((el) => parseFloat(getComputedStyle(el).paddingTop))
      expect(demoBottom, 'demo should not add a large gap before the next section').toBe(0)
      expect(featuresTop, 'encrypt section should sit closer to the preview').toBeLessThanOrEqual(
        32,
      )
      await expect(page.locator('#chat')).toHaveCount(0)
      await expect(page.locator('#search')).toHaveCount(0)
      const lockOrder = await page.evaluate(() => {
        const section = document.querySelector('#locks')
        if (!(section instanceof HTMLElement)) return null
        const topOf = (node: Element | null) => node?.getBoundingClientRect().top ?? -1
        return {
          title: topOf(section.querySelector('h2')),
          figure: topOf(section.querySelector('.illust-locks')),
          list: topOf(section.querySelector('.lock-list')),
        }
      })
      expect(lockOrder, 'locks section should exist').toBeTruthy()
      expect(lockOrder!.title).toBeLessThan(lockOrder!.list)
      expect(lockOrder!.list).toBeLessThan(lockOrder!.figure)
    } else {
      await expect(page.locator('.demo-poster')).toBeVisible()
      await expect(page.locator('.demo-placeholder')).toHaveCount(0)
    }
    await page.screenshot({
      path: testInfo.outputPath(`landing-${viewport.name}.png`),
      fullPage: true,
    })
    await expect(page.locator('.ai-grid article')).toHaveCount(14)
    await expect(page.locator('.ai-grid .ai-request')).toHaveText('Need more?')
    await expect(page.locator('[data-ai="coming"]')).toHaveText('More to come')
    if (compact) {
      await expect(page.locator('.ai-empty')).toBeHidden()
    } else {
      await expect(page.locator('.ai-empty')).toBeVisible()
      await expect(page.locator('.ai-grid .ai-request')).toHaveAttribute(
        'href',
        'https://github.com/dinhanhthi/memlore/issues/new?title=AI%20feature%20request%3A%20&labels=enhancement',
      )
    }
    const aiGrid = await page.locator('.ai-grid').evaluate((el) => {
      const style = getComputedStyle(el)
      const cell = el.querySelector('article')
      const device = el.querySelector('article[data-ai="device"]')
      return {
        columns: style.gridTemplateColumns.split(' ').length,
        frameRadius: style.borderRadius,
        cellRadius: cell ? getComputedStyle(cell).borderRadius : '',
        deviceColumnEnd: device ? getComputedStyle(device).gridColumnEnd : '',
      }
    })
    const expectedAiColumns = viewport.width > COMPACT_MAX_PX ? 3 : viewport.width > 640 ? 2 : 1
    expect(
      aiGrid.columns,
      `AI lattice should be ${expectedAiColumns}-col at ${viewport.name}`,
    ).toBe(expectedAiColumns)
    expect(aiGrid.cellRadius, 'AI cells should share edges, not card radii').toBe('0px')
    expect(aiGrid.frameRadius, 'AI lattice sits flush to the ledger, no floating card').toBe('0px')
    expect(aiGrid.deviceColumnEnd, 'On-device cell should span the row').toBe('-1')
    const titleBoxes = await page.locator('.ai-grid h3').evaluateAll((nodes) =>
      nodes.map((el) => ({
        text: el.textContent,
        wrap: getComputedStyle(el).whiteSpace,
        scroll: el.scrollWidth,
        client: el.clientWidth,
      })),
    )
    for (const title of titleBoxes) {
      expect(title.wrap, `${title.text} should wrap instead of clipping`).not.toBe('nowrap')
      expect(title.scroll, `${title.text} clipped inside the lattice`).toBeLessThanOrEqual(
        title.client + 1,
      )
    }
    await expect(page.locator('.compare-card-memlore > h3')).not.toContainText(/open source/i)
    if (!compact) {
      await expect(
        page.locator('.comparison-scroll thead').getByRole('columnheader', { name: 'Memlore' }),
      ).not.toContainText(/open source/i)
      const titleSize = await page
        .locator('.comparison-scroll thead th')
        .nth(1)
        .evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
      expect(
        titleSize,
        'comparison app titles should read larger than table body',
      ).toBeGreaterThanOrEqual(16)
    }
    await expectChromeSingleLine(page, compact)
    await expectNoRootOverflow(page)
    expect(errors.pageErrors, errors.pageErrors.join('\n')).toEqual([])
    expect(errors.consoleErrors, errors.consoleErrors.join('\n')).toEqual([])
  })
}

test('number gutter and ordinals appear together', async ({ page }) => {
  const measure = () =>
    page.evaluate(() => {
      const gutter = getComputedStyle(document.documentElement)
        .getPropertyValue('--page-gutter')
        .trim()
      const rule = document.querySelector('.ledger-rule')
      const ordinal = rule ? getComputedStyle(rule, '::before').content : 'none'
      return { gutter, ordinal }
    })

  await page.setViewportSize({ width: 800, height: 800 })
  await page.goto('/')
  const mid = await measure()
  expect(mid.gutter, 'mid widths should not reserve the number column').toMatch(/^0(px)?$/)
  expect(mid.ordinal === 'none' || mid.ordinal === '""', 'mid widths should hide 01 02 03').toBe(
    true,
  )

  await page.setViewportSize({ width: 1280, height: 800 })
  const wide = await measure()
  expect(wide.gutter, 'wide widths should open the number column').toBe('2.5rem')
  expect(
    wide.ordinal === 'none' || wide.ordinal === '""',
    'wide widths should paint ordinals',
  ).toBe(false)
})

const THEME_PICKER = 'Choose appearance'

type LandingChrome = {
  paper: string
  panel: string
  raised: string
  radiusPanel: string
  radiusControl: string
  buttonRise: string
  buttonPrimaryShadow: string
  headingFont: string
  bodyFont: string
  interLoaded: boolean
  plexMonoLoaded: boolean
  designSystem: string
}

async function readLandingChrome(page: Page): Promise<LandingChrome> {
  return page.evaluate(async () => {
    await document.fonts.ready
    const root = getComputedStyle(document.documentElement)
    const heading = document.querySelector('h1')
    return {
      paper: root.getPropertyValue('--color-paper').trim(),
      panel: root.getPropertyValue('--color-panel').trim(),
      raised: root.getPropertyValue('--color-raised').trim(),
      radiusPanel: root.getPropertyValue('--radius-panel').trim(),
      radiusControl: root.getPropertyValue('--radius-control').trim(),
      buttonRise: root.getPropertyValue('--button-rise').trim(),
      buttonPrimaryShadow: root.getPropertyValue('--button-primary-shadow').trim(),
      headingFont: heading ? getComputedStyle(heading).fontFamily : '',
      bodyFont: getComputedStyle(document.body).fontFamily,
      interLoaded: document.fonts.check('16px "Inter Variable"'),
      plexMonoLoaded: document.fonts.check('16px "IBM Plex Mono"'),
      designSystem: document.documentElement.getAttribute('data-design-system') ?? '',
    }
  })
}

function cssOklch(value: string) {
  return value
    .replace(/(\d+(?:\.\d+)?)%/g, (_, n: string) => String(Number(n) / 100).replace(/^0\./, '.'))
    .replace(/(^|[^\d.])0\./g, '$1.')
}

function expectHybridLandingChrome(chrome: LandingChrome) {
  expect(cssOklch(chrome.paper), 'paper').toBe('oklch(.145 .004 55)')
  expect(cssOklch(chrome.panel), 'panel').toBe('oklch(.185 .004 55)')
  expect(cssOklch(chrome.raised), 'raised').toBe('oklch(.205 .004 55)')
  expect(cssOklch(chrome.radiusPanel), 'panel radius').toBe('.625rem')
  expect(cssOklch(chrome.radiusControl), 'control radius').toBe('.625rem')
  expect(chrome.buttonRise, 'no clay rise').toBe('0px')
  expect(chrome.buttonPrimaryShadow, 'flat primary').toBe('none')
  expect(chrome.headingFont, 'Inter heading').toMatch(/Inter/i)
  expect(chrome.bodyFont, 'Inter body').toMatch(/Inter/i)
  expect(chrome.interLoaded, 'Inter face must be loaded').toBe(true)
  expect(chrome.plexMonoLoaded, 'IBM Plex Mono face must be loaded').toBe(true)
  expect(chrome.designSystem, 'landing html must not switch skins').toBe('')
}

test('CTA buttons stay fully rounded while the picker restyles only the demo', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await useLightLanding(page)
  await page.goto('/')
  await waitForDemoReady(page)
  const download = page.locator('.hero .download')
  const secondary = page.locator('.hero .button')
  const picker = page.getByRole('radiogroup', { name: THEME_PICKER })
  const frameHtml = demoFrame(page).locator('html')
  const before = await readLandingChrome(page)
  expectHybridLandingChrome(before)
  for (const name of ['Clay', 'Clean', 'Signature'] as const) {
    await picker.getByRole('radio', { name }).click()
    await expect(frameHtml).toHaveClass(new RegExp(`\\bds-${name.toLowerCase()}\\b`))
    expectHybridLandingChrome(await readLandingChrome(page))
    const downloadPx = await download.evaluate((el) =>
      parseFloat(getComputedStyle(el).borderRadius),
    )
    const secondaryPx = await secondary.evaluate((el) =>
      parseFloat(getComputedStyle(el).borderRadius),
    )
    expect(downloadPx, `${name} primary radius`).toBeGreaterThanOrEqual(8)
    expect(downloadPx, `${name} primary radius`).toBeLessThanOrEqual(12)
    expect(secondaryPx, `${name} secondary radius`).toBeGreaterThanOrEqual(8)
    expect(secondaryPx, `${name} secondary radius`).toBeLessThanOrEqual(12)
  }
  expect(await readLandingChrome(page)).toEqual(before)
})

test('download CTAs have a dark face, white label, and traveling glow', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await useLightLanding(page)
  await page.goto('/')
  const hero = page.locator('.hero .download')
  await expect(hero.locator('.download-glow')).toHaveCount(1)
  await expect(hero.locator('.download-glow-h')).toHaveCount(1)
  await expect(hero.locator('.download-glow-v')).toHaveCount(1)
  await expect(page.locator('.header-actions .download .download-glow')).toHaveCount(1)
  await expect(page.locator('.footer-main .download .download-glow')).toHaveCount(1)
  const animation = await hero
    .locator('.download-glow-h')
    .evaluate((el) => getComputedStyle(el).animationName)
  expect(animation).toMatch(/download-glow-orbit/)
  const face = await relativeLuminance(hero, 'backgroundColor')
  const label = await relativeLuminance(hero, 'color')
  expect(face, 'download face should stay dark so the glow reads').toBeLessThan(0.12)
  expect(label, 'download label should be near-white').toBeGreaterThan(0.9)
  const accentFace = await page.evaluate(() => {
    const probe = document.createElement('span')
    probe.style.backgroundColor = 'var(--color-accent)'
    document.body.append(probe)
    const color = getComputedStyle(probe).backgroundColor
    probe.remove()
    return color
  })
  const bg = await hero.evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(bg, 'download face must not match the amber accent fill').not.toBe(accentFace)
})

async function relativeLuminance(locator: Locator, property: 'color' | 'backgroundColor') {
  return locator.evaluate((el, propertyName) => {
    const value = getComputedStyle(el)[propertyName]
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const ctx = canvas.getContext('2d')
    if (!ctx) return 0
    ctx.fillStyle = value
    ctx.fillRect(0, 0, 1, 1)
    const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data
    const toLin = (channel: number) => {
      const srgb = channel / 255
      return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b)
  }, property)
}

test('demo option badges stay bright and unclipped at the bottom', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await useLightLanding(page)
  await page.goto('/')
  await waitForDemoReady(page)
  const picker = page.getByRole('radiogroup', { name: THEME_PICKER })
  const selected = picker.getByRole('radio', { checked: true })
  const idle = picker.getByRole('radio', { checked: false }).first()
  const muted = page.locator('.hero-description')
  const paper = page.locator('body')
  const idleText = await relativeLuminance(idle, 'color')
  const selectedText = await relativeLuminance(selected, 'color')
  const idleFill = await relativeLuminance(idle, 'backgroundColor')
  const mutedText = await relativeLuminance(muted, 'color')
  const paperFill = await relativeLuminance(paper, 'backgroundColor')
  expect(idleText, 'idle badge text should stay light on dark paper').toBeGreaterThan(0.35)
  expect(
    idleText,
    'idle badge text should stay at least as light as muted copy',
  ).toBeGreaterThanOrEqual(mutedText - 0.05)
  expect(selectedText, 'selected badge text should stay light').toBeGreaterThan(0.35)
  expect(idleFill, 'idle badge fill should sit off dark paper').toBeGreaterThan(paperFill)
  expect(await idle.evaluate((el) => getComputedStyle(el).boxShadow)).toBe('none')
  expect(await selected.evaluate((el) => getComputedStyle(el).boxShadow)).toBe('none')
  const rowBox = await page.locator('.demo-chrome').boundingBox()
  const idleBox = await idle.boundingBox()
  const selectedBox = await selected.boundingBox()
  expect(rowBox, 'option badges should have a box').toBeTruthy()
  expect(idleBox, 'idle badge should have a box').toBeTruthy()
  expect(selectedBox, 'selected badge should have a box').toBeTruthy()
  expect(idleBox!.y + idleBox!.height, 'idle badge clipped at the bottom').toBeLessThanOrEqual(
    rowBox!.y + rowBox!.height + 1,
  )
  expect(
    selectedBox!.y + selectedBox!.height,
    'selected badge clipped at the bottom',
  ).toBeLessThanOrEqual(rowBox!.y + rowBox!.height + 1)
})

test('lock titles and descriptions share one paragraph', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  const items = page.locator('.lock-list li')
  await expect(items).toHaveCount(3)
  await expect(items.locator('h3')).toHaveCount(0)
  await expect(items.first().locator('p')).toHaveCount(1)
  await expect(items.first().locator('p')).toContainText(/App lock/)
  await expect(items.first().locator('p')).toContainText(/password or Touch ID/)
})

function firstRowCount(page: Page, selector: string) {
  return page.locator(selector).evaluate((el) => {
    const items = [...el.children] as HTMLElement[]
    if (items.length === 0) return 0
    const firstTop = items[0].getBoundingClientRect().top
    return items.filter((item) => Math.abs(item.getBoundingClientRect().top - firstTop) < 2).length
  })
}

for (const width of [320, 375, 414] as const) {
  test(`editor illustration fits 3 cards per row at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 812 })
    await page.goto('/')
    const perRow = await page.locator('.illust-editor').evaluate((el) => {
      const cards = [...el.querySelectorAll('.ed-card')]
      if (cards.length === 0) return 0
      const firstTop = cards[0].getBoundingClientRect().top
      return cards.filter((card) => Math.abs(card.getBoundingClientRect().top - firstTop) < 2)
        .length
    })
    expect(
      perRow,
      `expected at least 3 editor cards on the first row at ${width}`,
    ).toBeGreaterThanOrEqual(3)
    await expectNoRootOverflow(page)
  })
}

for (const id of [
  'features',
  'sync',
  'locks',
  'editor',
  'emotions',
  'locations',
  'import-export',
  'persona',
] as const) {
  test(`compact ${id} illustration sits in its own cell, flush to the floor`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    const geometry = await page.evaluate((sectionId) => {
      const section = document.getElementById(sectionId)
      const figure = section?.querySelector(':scope > .illust')
      const copy = [...(section?.children ?? [])].find((node) => node !== figure)
      if (
        !(section instanceof HTMLElement) ||
        !(copy instanceof HTMLElement) ||
        !(figure instanceof HTMLElement)
      ) {
        return null
      }
      const sectionBox = section.getBoundingClientRect()
      const copyBox = copy.getBoundingClientRect()
      const figureBox = figure.getBoundingClientRect()
      const first = figure.firstElementChild
      const last = figure.lastElementChild
      const firstBox = first?.getBoundingClientRect()
      const lastBox = last?.getBoundingClientRect()
      return {
        copyBottom: copyBox.bottom,
        figureTop: figureBox.top,
        figureBottom: figureBox.bottom,
        sectionBottom: sectionBox.bottom,
        borderTop: getComputedStyle(figure).borderTopWidth,
        innerTop: firstBox ? firstBox.top - figureBox.top : 0,
        innerBottom: lastBox ? figureBox.bottom - lastBox.bottom : 0,
      }
    }, id)
    expect(geometry, `${id} copy and figure should exist`).toBeTruthy()
    expect(geometry!.figureTop, `${id} figure should sit below the copy`).toBeGreaterThan(
      geometry!.copyBottom - 1,
    )
    expect(
      Number.parseFloat(geometry!.borderTop),
      `${id} should have a hairline above the figure`,
    ).toBeGreaterThan(0)
    expect(
      geometry!.sectionBottom - geometry!.figureBottom,
      `${id} figure should sit flush to the section floor`,
    ).toBeLessThanOrEqual(2)
    if (
      id === 'import-export' ||
      id === 'emotions' ||
      id === 'features' ||
      id === 'sync' ||
      id === 'locks' ||
      id === 'persona'
    ) {
      expect(
        Math.abs(geometry!.innerTop - geometry!.innerBottom),
        `${id} figure padding below should match padding above`,
      ).toBeLessThanOrEqual(1)
    }
  })
}

test('feature sections meet at a hairline with no empty join row', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 })
  await page.goto('/')
  await expect(page.locator('.split-gap')).toHaveCount(0)
  const join = await page.evaluate(() => {
    const ids = [
      'features',
      'sync',
      'locks',
      'editor',
      'emotions',
      'locations',
      'import-export',
      'looks',
      'talk',
      'persona',
    ]
    return ids.slice(0, -1).map((id, index) => {
      const current = document.getElementById(id)
      const next = document.getElementById(ids[index + 1])
      const rule = current?.nextElementSibling
      return {
        from: id,
        to: ids[index + 1],
        rule: rule instanceof HTMLElement && rule.classList.contains('ledger-rule'),
        gap:
          next && current
            ? next.getBoundingClientRect().top - current.getBoundingClientRect().bottom
            : -1,
      }
    })
  })
  expect(join).toHaveLength(9)
  for (const step of join) {
    expect(step.rule, `${step.from} should be followed by a hairline`).toBe(true)
    expect(step.gap, `${step.from} should sit against the next feature`).toBeLessThanOrEqual(2)
  }
})

for (const width of [320, 375, 414] as const) {
  test(`import/export chips wrap 2 then 3 per row at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 812 })
    await page.goto('/')
    await expect(firstRowCount(page, '.transfer-in')).resolves.toBe(2)
    await expect(firstRowCount(page, '.transfer-out')).resolves.toBe(3)
    const wrap = await page
      .locator('.transfer-col span, .transfer-hub')
      .evaluateAll((nodes) => nodes.map((el) => getComputedStyle(el).whiteSpace))
    expect(wrap.every((value) => value === 'nowrap')).toBe(true)
    await expectNoRootOverflow(page)
  })
}

test('compact emotion illustration keeps padding from the rails', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  const inset = await page.evaluate(() => {
    const section = document.getElementById('emotions')
    const figure = section?.querySelector('.illust-emotions')
    const prompt = figure?.querySelector('.emotion-prompt')
    const pills = figure?.querySelector('.emotion-options')
    if (
      !(section instanceof HTMLElement) ||
      !(figure instanceof HTMLElement) ||
      !(prompt instanceof HTMLElement) ||
      !(pills instanceof HTMLElement)
    ) {
      return null
    }
    const sectionBox = section.getBoundingClientRect()
    const figureBox = figure.getBoundingClientRect()
    const promptBox = prompt.getBoundingClientRect()
    const pillsBox = pills.getBoundingClientRect()
    return {
      promptLeft: promptBox.left - sectionBox.left,
      pillsLeft: pillsBox.left - sectionBox.left,
      pillsRight: sectionBox.right - pillsBox.right,
      promptTop: promptBox.top - figureBox.top,
      pillsBottom: figureBox.bottom - pillsBox.bottom,
    }
  })
  expect(inset, 'emotion prompt and pills should exist').toBeTruthy()
  expect(inset!.promptLeft, 'prompt should not sit on the left rail').toBeGreaterThanOrEqual(16)
  expect(inset!.pillsLeft, 'pills should not sit on the left rail').toBeGreaterThanOrEqual(16)
  expect(inset!.pillsRight, 'pills should not sit on the right rail').toBeGreaterThanOrEqual(16)
  expect(inset!.promptTop, 'prompt should have padding above').toBeGreaterThanOrEqual(16)
  expect(
    Math.abs(inset!.promptTop - inset!.pillsBottom),
    'emotion figure padding below should match padding above',
  ).toBeLessThanOrEqual(1)
})

test('feature splits alternate illustration side and AI sits above open source', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  const ids = await page.evaluate(() =>
    [...document.querySelectorAll('main section[id]')].map((section) => section.id),
  )
  const fromFeatures = ids.slice(ids.indexOf('features'))
  expect(fromFeatures.slice(0, 12)).toEqual([
    'features',
    'sync',
    'locks',
    'editor',
    'emotions',
    'locations',
    'import-export',
    'looks',
    'talk',
    'persona',
    'ai',
    'open-source',
  ])
  const sides = await page.evaluate(() => {
    const of = (id: string, figure: string) => {
      const section = document.getElementById(id)
      const fig = section?.querySelector(figure)
      const title = section?.querySelector('h2')
      if (!fig || !title) return null
      return fig.getBoundingClientRect().left < title.getBoundingClientRect().left
        ? 'left'
        : 'right'
    }
    return {
      features: of('features', '.illust-encrypt'),
      sync: of('sync', '.illust-encrypt'),
      locks: of('locks', '.illust-locks'),
      editor: of('editor', '.illust-editor'),
      emotions: of('emotions', '.illust-emotions'),
      locations: of('locations', '.illust-map'),
      importExport: of('import-export', '.illust-transfer'),
      looks: of('looks', '.illust-looks'),
      talk: of('talk', '.illust-talk'),
      persona: of('persona', '.illust-persona'),
    }
  })
  expect(sides).toEqual({
    features: 'right',
    sync: 'left',
    locks: 'right',
    editor: 'left',
    emotions: 'right',
    locations: 'left',
    importExport: 'right',
    looks: 'left',
    talk: 'right',
    persona: 'left',
  })
  const insets = await page.evaluate(() => {
    const gap = (figure: string, inner: string) => {
      const fig = document.querySelector(figure)
      const plate = document.querySelector(inner)
      if (!(fig instanceof Element) || !(plate instanceof Element)) return null
      const outer = fig.getBoundingClientRect()
      const box = plate.getBoundingClientRect()
      return {
        left: box.left - outer.left,
        right: outer.right - box.right,
        top: box.top - outer.top,
        bottom: outer.bottom - box.bottom,
      }
    }
    return {
      locks: gap('.illust-locks', '.illust-locks > article'),
      map: gap('.illust-map', '.illust-map > .map-svg'),
    }
  })
  expect(insets.locks, 'locks plate should exist').toBeTruthy()
  expect(insets.map, 'map plate should exist').toBeTruthy()
  expect(insets.locks!.left, 'locks left inset').toBeGreaterThan(16)
  expect(insets.locks!.right, 'locks right inset').toBeGreaterThan(16)
  expect(insets.locks!.top, 'locks top inset').toBeGreaterThan(16)
  expect(insets.locks!.bottom, 'locks bottom inset').toBeGreaterThan(16)
  expect(
    Math.abs(insets.locks!.left - insets.locks!.right),
    'locks plate should be horizontally centered',
  ).toBeLessThanOrEqual(2)
  expect(
    Math.abs(insets.locks!.top - insets.locks!.bottom),
    'locks plate should be vertically centered',
  ).toBeLessThanOrEqual(2)
  expect(insets.map!.left, 'map left inset').toBeLessThanOrEqual(1)
  expect(insets.map!.right, 'map right inset').toBeLessThanOrEqual(1)
  expect(insets.map!.top, 'map top inset').toBeLessThanOrEqual(1)
  expect(insets.map!.bottom, 'map bottom inset').toBeLessThanOrEqual(1)
  const videoPin = await page.evaluate(() => {
    const fig = document.querySelector('.illust-map')
    const badge = document.querySelector('[data-map-pin="video"] .map-photo-frame')
    const ocean = document.querySelector('.map-ocean')
    const rule = document.querySelector('#locations')?.previousElementSibling
    if (
      !(fig instanceof Element) ||
      !(badge instanceof Element) ||
      !(ocean instanceof Element) ||
      !(rule instanceof HTMLElement)
    ) {
      return null
    }
    const figBox = fig.getBoundingClientRect()
    const oceanBox = ocean.getBoundingClientRect()
    const badgeBox = badge.getBoundingClientRect()
    const hit = document.elementFromPoint(badgeBox.left + badgeBox.width / 2, badgeBox.top + 2)
    return {
      pinAbove: badgeBox.top - figBox.top,
      oceanLeft: oceanBox.left - figBox.left,
      oceanRight: figBox.right - oceanBox.right,
      hitIsRule: hit instanceof Element && hit.classList.contains('ledger-rule'),
    }
  })
  expect(videoPin, 'video map pin should exist').not.toBeNull()
  expect(videoPin!.pinAbove, 'video badge may poke above the map cell').toBeLessThan(2)
  expect(videoPin!.oceanLeft, 'map must stay inside the cell on the left').toBeGreaterThanOrEqual(
    -1,
  )
  expect(videoPin!.oceanRight, 'map must stay inside the cell on the right').toBeGreaterThanOrEqual(
    -1,
  )
  expect(videoPin!.hitIsRule, 'video badge must paint above the hairline').toBe(false)
})

test('editor cards are icon-plus-label tiles with a request link and a striped empty slot', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await useLightLanding(page)
  await page.goto('/')
  const section = page.locator('#editor')
  await expect(section.getByRole('heading', { level: 2 })).toContainText(/editor/i)
  await expect(page.locator('.ed-card')).toHaveCount(9)
  expect(await firstRowCount(page, '.illust-editor')).toBe(5)
  const media = page.locator('.ed-media')
  await expect(media).toHaveText('Media')
  await expect(media.locator('svg')).toHaveCount(1)
  const slash = page.locator('.ed-slash')
  await expect(slash.locator('.ed-slash-mark')).toHaveText('/')
  await expect(slash).toHaveText(/Slash command/)
  const markdown = page.locator('.ed-markdown')
  await expect(markdown).toHaveText(/^Markdown$/)
  await expect(markdown.locator('.ed-tag')).toHaveCount(0)
  const plugins = page.locator('.ed-plugins')
  await expect(plugins).toHaveText('More plugins')
  const pluginsBg = await plugins.evaluate((el) => getComputedStyle(el).backgroundColor)
  const mediaBg = await media.evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(pluginsBg, 'More plugins should match the other cards').toBe(mediaBg)
  const request = page.locator('.ed-request')
  await expect(request).toHaveText('Need more?')
  await expect(request).toHaveAttribute(
    'href',
    'https://github.com/dinhanhthi/memlore/issues/new?title=Editor%20feature%20request%3A%20&labels=enhancement',
  )
  await expect(request).toHaveAttribute('target', '_blank')
  const empty = page.locator('.ed-empty')
  await expect(empty).toHaveCount(1)
  expect(await empty.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain(
    'repeating-linear-gradient',
  )
  const wrap = await page
    .locator('.ed-card span:not(.ed-slash-mark)')
    .evaluateAll((nodes) => nodes.map((el) => getComputedStyle(el).whiteSpace))
  expect(wrap.every((value) => value === 'nowrap')).toBe(true)
  const labelLuminance = await relativeLuminance(
    page.locator('.ed-card span:not(.ed-slash-mark)').first(),
    'color',
  )
  expect(labelLuminance, 'editor card labels should stay light on dark paper').toBeGreaterThan(0.35)
})

test('demo Settings restyles the iframe only', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await useLightLanding(page)
  await page.goto('/')
  await waitForDemoReady(page)
  const frame = demoFrame(page)
  const frameHtml = frame.locator('html')
  const picker = page.getByRole('radiogroup', { name: THEME_PICKER })
  const before = await readLandingChrome(page)
  expectHybridLandingChrome(before)

  await frame.getByRole('button', { name: 'Settings' }).first().click()
  await frame.getByRole('tab', { name: 'Appearance' }).click()
  const systems = [
    { name: 'Clean design system', id: 'clean' },
    { name: 'Switch to the Clay design system', id: 'clay' },
    { name: 'Signature design system', id: 'signature' },
  ] as const
  for (const system of systems) {
    await frame.getByRole('radio', { name: system.name }).click()
    await expect(frameHtml).toHaveClass(new RegExp(`\\bds-${system.id}\\b`))
    await expect(picker.getByRole('radio', { name: new RegExp(system.id, 'i') })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expectHybridLandingChrome(await readLandingChrome(page))
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme))
      .toBe('dark')
  }
  expect(await readLandingChrome(page)).toEqual(before)
})

test('demo skins sit at the mockup top-left with Open separately', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await waitForDemoReady(page)
  await expect(page.getByRole('button', { name: 'Write a little' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Look back' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Ask your journal' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Keep it private' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Reset demo' })).toHaveCount(0)

  const mockup = page.locator('.demo-window')
  const chrome = page.locator('.demo-chrome')
  const picker = chrome.getByRole('radiogroup', { name: THEME_PICKER })
  const label = chrome.locator('.demo-chrome-label')
  const open = chrome.getByRole('link', { name: /open separately/i })
  await expect(label).toHaveText(/choose appearance/i)
  await expect(picker.getByRole('radio', { name: 'Clay' })).toBeVisible()
  await expect(picker.getByRole('radio', { name: 'Clean' })).toBeVisible()
  await expect(picker.getByRole('radio', { name: 'Signature' })).toBeVisible()
  await expect(open).toHaveAttribute('href', './demo.html')

  const mockupBox = await mockup.boundingBox()
  const chromeBox = await chrome.boundingBox()
  const labelBox = await label.boundingBox()
  const clayBox = await picker.getByRole('radio', { name: 'Clay' }).boundingBox()
  const openBox = await open.boundingBox()
  expect(mockupBox, 'mockup should have a box').toBeTruthy()
  expect(chromeBox, 'demo chrome should have a box').toBeTruthy()
  expect(labelBox, 'Choose appearance should have a box').toBeTruthy()
  expect(clayBox, 'Clay badge should have a box').toBeTruthy()
  expect(openBox, 'Open separately should have a box').toBeTruthy()
  expect(labelBox!.x, 'Choose appearance should sit left of the skins').toBeLessThan(clayBox!.x)
  expect(chromeBox!.y, 'chrome should sit on the mockup').toBeGreaterThanOrEqual(mockupBox!.y - 1)
  expect(chromeBox!.x, 'chrome should sit on the left of the mockup').toBeGreaterThanOrEqual(
    mockupBox!.x - 1,
  )
  expect(chromeBox!.y - mockupBox!.y, 'chrome should be at the top').toBeLessThan(16)
  expect(chromeBox!.x - mockupBox!.x, 'chrome should be at the left').toBeLessThan(16)
  expect(openBox!.x, 'Open separately should sit right of the skins').toBeGreaterThan(
    clayBox!.x + clayBox!.width,
  )
  expect(
    chromeBox!.x + chromeBox!.width - (openBox!.x + openBox!.width),
    'Open separately should sit at the right edge',
  ).toBeLessThan(16)
  expect(
    Math.abs(openBox!.y - clayBox!.y),
    'Open separately should share the skins row',
  ).toBeLessThan(12)
  expect(clayBox!.height, 'skin badges should be smaller').toBeLessThanOrEqual(28)
  const fontSize = await picker
    .getByRole('radio', { name: 'Clay' })
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
  expect(fontSize, 'skin badge type should be smaller').toBeLessThanOrEqual(12)
})

test('demo disclaimer tracks the mockup bottom edge', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  const mockup = page.locator('.demo-window')
  const disclaimer = page.locator('.demo-disclaimer')
  await expect(disclaimer).toBeVisible()
  const layout = await page.evaluate(() => {
    const stage = document.querySelector('.demo-stage')
    const windowEl = document.querySelector('.demo-window')
    const text = document.querySelector('.demo-disclaimer')
    if (
      !(stage instanceof HTMLElement) ||
      !(windowEl instanceof HTMLElement) ||
      !(text instanceof HTMLElement)
    ) {
      return null
    }
    return {
      windowLeft: windowEl.offsetLeft,
      textLeft: text.offsetLeft,
      windowRight: windowEl.offsetLeft + windowEl.offsetWidth,
      stageWidth: stage.clientWidth,
      windowBottom: windowEl.offsetTop + windowEl.offsetHeight,
      textTop: text.offsetTop,
      parent: text.parentElement === stage,
    }
  })
  expect(layout, 'demo stage, window, and disclaimer should exist').toBeTruthy()
  expect(layout!.parent, 'disclaimer should stay a child of the existing stage').toBe(true)
  expect(
    layout!.windowLeft,
    'demo should sit flush with the left content rail',
  ).toBeLessThanOrEqual(1)
  expect(
    layout!.stageWidth - layout!.windowRight,
    'demo should sit flush with the right content rail',
  ).toBeLessThanOrEqual(1)
  expect(layout!.textLeft, 'disclaimer should share the mockup left edge').toBe(layout!.windowLeft)
  expect(layout!.textTop, 'disclaimer should sit under the mockup').toBeGreaterThanOrEqual(
    layout!.windowBottom,
  )
  const mockupTransform = await mockup.evaluate((el) => getComputedStyle(el).transform)
  const textTransform = await disclaimer.evaluate((el) => getComputedStyle(el).transform)
  expect(textTransform, 'disclaimer should stay parallel to the mockup').toBe(mockupTransform)
  const textLum = await relativeLuminance(disclaimer, 'color')
  const mutedLum = await relativeLuminance(page.locator('.hero-description'), 'color')
  expect(
    textLum,
    'disclaimer should stay at least as light as muted body copy',
  ).toBeGreaterThanOrEqual(mutedLum)
  const stacking = await page.evaluate(() => {
    const windowEl = document.querySelector('.demo-window')
    const text = document.querySelector('.demo-disclaimer')
    if (!(windowEl instanceof HTMLElement) || !(text instanceof HTMLElement)) return null
    return {
      windowZ: Number.parseFloat(getComputedStyle(windowEl).zIndex) || 0,
      textZ: Number.parseFloat(getComputedStyle(text).zIndex) || 0,
    }
  })
  expect(stacking, 'mockup and disclaimer should exist').toBeTruthy()
  expect(stacking!.textZ, 'disclaimer must sit above the mockup shadow').toBeGreaterThan(
    stacking!.windowZ,
  )
})

test('compact nav opens fullscreen and closes on Escape', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto('/')
  const toggle = page.getByRole('button', { name: 'Open menu' })
  const nav = page.getByRole('navigation', { name: 'Main navigation' })
  const header = page.locator('.site-header')
  await expect(nav).toBeHidden()
  await toggle.click()
  await expect(nav).toBeVisible()
  await expect(page.getByRole('button', { name: 'Close menu' })).toBeVisible()
  const headerBox = await header.boundingBox()
  expect(headerBox, 'open header should have a box').toBeTruthy()
  expect(headerBox!.height, 'open menu should fill the viewport').toBeGreaterThanOrEqual(811)
  expect(headerBox!.width, 'open menu should span the viewport').toBeGreaterThanOrEqual(374)
  await expect(nav.locator('.nav-rule')).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Download the beta from GitHub' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('nav-open.png') })
  await page.keyboard.press('Escape')
  await expect(nav).toBeHidden()
  await expect(toggle).toBeFocused()
  await toggle.click()
  await page.getByRole('link', { name: 'Memlore home' }).click()
  await expect(nav).toBeHidden()
})

test('compact nav keeps the header bar still and only swaps burger for close', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto('/')
  const wordmark = page.getByRole('link', { name: 'Memlore home' })
  const github = page.locator('.header-github')
  const toggle = page.getByRole('button', { name: 'Open menu' })
  const closedWordmark = await wordmark.boundingBox()
  const closedGithub = await github.boundingBox()
  const closedToggle = await toggle.boundingBox()
  expect(closedWordmark, 'closed logo should have a box').toBeTruthy()
  expect(closedGithub, 'closed GitHub should have a box').toBeTruthy()
  expect(closedToggle, 'burger should have a box').toBeTruthy()

  await toggle.click()
  const openWordmark = await wordmark.boundingBox()
  const openGithub = await github.boundingBox()
  const close = page.getByRole('button', { name: 'Close menu' })
  const openClose = await close.boundingBox()
  expect(openWordmark, 'open logo should have a box').toBeTruthy()
  expect(openGithub, 'GitHub must stay in the header when the menu is open').toBeTruthy()
  expect(openClose, 'close should have a box').toBeTruthy()
  await expect(github).toBeVisible()
  expect(
    Math.abs(openWordmark!.x - closedWordmark!.x),
    'logo x should not move when the menu opens',
  ).toBeLessThanOrEqual(1)
  expect(
    Math.abs(openWordmark!.y - closedWordmark!.y),
    'logo y should not move when the menu opens',
  ).toBeLessThanOrEqual(1)
  expect(
    Math.abs(openGithub!.x - closedGithub!.x),
    'GitHub x should not move when the menu opens',
  ).toBeLessThanOrEqual(1)
  expect(
    Math.abs(openGithub!.y - closedGithub!.y),
    'GitHub y should not move when the menu opens',
  ).toBeLessThanOrEqual(1)
  expect(
    Math.abs(openClose!.x - closedToggle!.x),
    'close should sit where the burger was (x)',
  ).toBeLessThanOrEqual(1)
  expect(
    Math.abs(openClose!.y - closedToggle!.y),
    'close should sit where the burger was (y)',
  ).toBeLessThanOrEqual(1)
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

  await expect(page.locator('.header-github')).toHaveAttribute('href', GITHUB)
  await expect(page.locator('.header-github .github-mark')).toHaveCount(1)
  const download = page.locator('.hero .download')
  await expect(download).toHaveAttribute('href', DOWNLOAD)
  await expect(download).toHaveAttribute('aria-label', /beta from GitHub/i)
  const macosStatus = page.locator('.platform-list strong a')
  await expect(macosStatus).toHaveAttribute('href', DOWNLOAD)
  await expect(macosStatus).toHaveAttribute('aria-label', /beta from GitHub/i)
  await expect(macosStatus).toContainText(/download/i)
  await expect(page.getByRole('link', { name: /app store|play store/i })).toHaveCount(0)
  await expect(page.locator('.site-header')).toHaveCSS('position', 'sticky')
})

test('doc disclosure stays open on inside click and closes on outside click', async ({ page }) => {
  await page.goto('/')
  const doc = page.locator('details.doc-menu')
  await doc.locator('summary').click()
  await expect(doc).toHaveAttribute('open', '')

  await doc.locator('p').click()
  await expect(doc).toHaveAttribute('open', '')

  await page.getByRole('heading', { level: 1 }).click()
  await expect(doc).not.toHaveAttribute('open')
})

test('lock UI exists and chat composer is reachable after guided navigation', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await waitForDemoReady(page)
  const frame = demoFrame(page)

  await frame.getByRole('button', { name: 'Settings' }).first().click()
  await frame.getByRole('tab', { name: 'Security', exact: true }).click()
  await frame.getByRole('tab', { name: 'Second lock' }).click()
  await expect(
    frame.getByRole('button', { name: /change password|unlock|disable second lock/i }).first(),
  ).toBeVisible({
    timeout: 20_000,
  })

  await frame.getByRole('button', { name: 'Chat', exact: true }).click()
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
