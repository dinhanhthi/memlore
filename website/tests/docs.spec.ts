import { expect, test, type Page } from '@playwright/test'
import { DOCS_PAGES, docsPath, neighbours } from '../src/docs/manifest'

/**
 * ResizeObserver loops are Chromium noise, same filter as legal.spec.ts.
 * Any other console error, page error, or HTTP status >= 400 is a failure.
 */
const IGNORED_CONSOLE = [/ResizeObserver loop/i]

function attachErrorCollectors(page: Page) {
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  const failedResponses: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const text = message.text()
    if (IGNORED_CONSOLE.some((pattern) => pattern.test(text))) return
    consoleErrors.push(text)
  })
  page.on('response', (response) => {
    if (response.status() < 400) return
    failedResponses.push(`${response.status()} ${response.url()}`)
  })
  return { pageErrors, consoleErrors, failedResponses }
}

function expectQuiet(errors: ReturnType<typeof attachErrorCollectors>) {
  expect(errors.pageErrors, errors.pageErrors.join('\n')).toEqual([])
  expect(errors.consoleErrors, errors.consoleErrors.join('\n')).toEqual([])
  expect(errors.failedResponses, errors.failedResponses.join('\n')).toEqual([])
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

function escapedPath(path: string): RegExp {
  return new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
}

for (const doc of DOCS_PAGES) {
  test(`${docsPath(doc.slug)} shows ${doc.title} with no console, page, or network errors`, async ({
    page,
  }) => {
    const errors = attachErrorCollectors(page)
    const response = await page.goto(docsPath(doc.slug), { waitUntil: 'networkidle' })
    expect(response?.status(), doc.slug).toBeLessThan(400)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(doc.title)
    await expect(page.locator('.site-boot img')).toHaveAttribute(
      'src',
      '/logo-without-container/256.png',
    )
    await expect(page.locator('header .wordmark-head img')).toHaveAttribute(
      'src',
      /^\/head-rotate\/[^/]+\.png$/,
    )
    expectQuiet(errors)
  })
}

test('overview and encryption answer on the clean URL and the .html URL', async ({ request }) => {
  const pairs = [
    ['/docs/', '/docs/index.html', '<h1>Overview</h1>'],
    ['/docs/encryption', '/docs/encryption.html', '<h1>Encryption</h1>'],
  ] as const
  for (const [clean, file, heading] of pairs) {
    const cleanResponse = await request.get(clean)
    const fileResponse = await request.get(file)
    expect(cleanResponse.status(), clean).toBe(200)
    expect(fileResponse.status(), file).toBe(200)
    const cleanHtml = await cleanResponse.text()
    const fileHtml = await fileResponse.text()
    expect(cleanHtml, clean).toContain(heading)
    expect(fileHtml, file).toContain(heading)
    expect(cleanHtml, `${clean} should be the same document as ${file}`).toBe(fileHtml)
  }
})

test('pushState from the homepage opens encryption without a header logo 404', async ({ page }) => {
  const logoFailures: string[] = []
  page.on('response', (response) => {
    const { pathname } = new URL(response.url())
    const isLogo =
      pathname.startsWith('/head-rotate/') || pathname.startsWith('/logo-without-container/')
    if (!isLogo || response.status() < 400) return
    logoFailures.push(`${response.status()} ${pathname}`)
  })
  await page.goto('/')
  await page.evaluate(() => {
    history.pushState(null, '', '/docs/encryption')
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Encryption')
  await expect(page).toHaveURL(/\/docs\/encryption$/)
  await page.waitForLoadState('networkidle')
  await expect(page.locator('header .wordmark-head img')).toHaveAttribute(
    'src',
    /^\/head-rotate\/[^/]+\.png$/,
  )
  expect(logoFailures, logoFailures.join('\n')).toEqual([])
})

test('a narrow docs page does not scroll sideways', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(docsPath('overview'))
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expectNoRootOverflow(page)
})

test('every docs shell includes its h1 without JavaScript', async ({ request }) => {
  for (const doc of DOCS_PAGES) {
    const response = await request.get(docsPath(doc.slug))
    expect(response.status(), doc.slug).toBe(200)
    expect(await response.text(), doc.slug).toContain(`<h1>${doc.title}</h1>`)
  }
})

test('sidebar and pager navigate without a full reload', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const next = neighbours('overview').next
  if (!next) throw new Error('overview is missing a next page')
  await page.goto(docsPath('overview'))
  await expect(page.locator('html')).toHaveClass(/site-ready/)
  await expect(page.locator('.docs-sidebar')).toBeVisible()
  let reloaded = false
  page.on('load', () => {
    reloaded = true
  })

  await page
    .getByRole('navigation', { name: 'Pagination' })
    .getByRole('link', { name: next.title, exact: true })
    .click()
  await expect(page).toHaveURL(escapedPath(docsPath(next.slug)))
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(next.title)
  expect(reloaded, 'next pager must not full-reload').toBe(false)
  await expect(page.locator('html')).toHaveClass(/site-ready/)

  await page
    .getByRole('navigation', { name: 'Documentation' })
    .getByRole('link', { name: 'Overview', exact: true })
    .click()
  await expect(page).toHaveURL(/\/docs\/?$/)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Overview')
  expect(reloaded, 'sidebar must not full-reload').toBe(false)
  await expect(page.locator('html')).toHaveClass(/site-ready/)
})

test('overview table of contents scrolls to a heading that starts below the fold', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(docsPath('overview'))
  const toc = page.getByRole('navigation', { name: 'On this page' })
  await expect(toc.getByRole('link', { name: 'Where to start' })).toBeVisible()
  await expect(toc.getByRole('link', { name: 'What comes next' })).toBeVisible()
  const target = page.locator('#what-comes-next')
  await expect(target).not.toBeInViewport()
  await toc.getByRole('link', { name: 'What comes next' }).click()
  await expect(page).toHaveURL(/#what-comes-next$/)
  await expect(target).toBeInViewport()
})

test('encryption shows on-page contents once it has several sections', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(docsPath('encryption'))
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Encryption')
  await expect(page.getByRole('navigation', { name: 'On this page' })).toBeVisible()
})
