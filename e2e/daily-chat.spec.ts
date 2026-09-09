import { expect, test, type Page } from '@playwright/test'

async function openDailyChat(page: Page) {
  await page.goto('/?scenario=ai-connected')
  await page.getByRole('navigation').getByRole('button', { name: 'Chat', exact: true }).click()
}

async function tokenBackground(page: Page, token: string) {
  return page.evaluate((cssToken) => {
    const probe = document.createElement('div')
    probe.style.backgroundColor = `var(${cssToken})`
    document.body.append(probe)
    const background = getComputedStyle(probe).backgroundColor
    probe.remove()
    return background
  }, token)
}

async function seedClay(page: Page, theme: 'light' | 'dark') {
  await page.addInitScript((nextTheme) => {
    localStorage.setItem(
      'memlore-ui',
      JSON.stringify({ state: { designSystem: 'clay', theme: nextTheme }, version: 0 }),
    )
  }, theme)
}

test('Daily Chat does not offer a temporary clear-view action', async ({ page }) => {
  await openDailyChat(page)
  await page.getByText('Morning reflections', { exact: true }).click()

  await expect(page.getByRole('button', { name: 'Save as entry', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Clear view', exact: true })).toHaveCount(0)
})

test('Daily Chat filters by title while preserving and changing the selected transcript', async ({
  page,
}) => {
  await openDailyChat(page)
  const search = page.getByRole('searchbox', { name: 'Search conversations' })

  await expect(search).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Pagination for conversations' })).toBeVisible()

  await page.getByText('Morning reflections', { exact: true }).click()
  await expect(page.getByText(/Good morning! It's wonderful/)).toBeVisible()

  await search.fill('processing difficult week')
  await expect(page.getByText('Processing a difficult week', { exact: true })).toBeVisible()
  await expect(
    page.getByRole('complementary').getByText('Morning reflections', { exact: true }),
  ).toHaveCount(0)
  await expect(
    page.getByText('Selected conversation is outside these search results.', { exact: true }),
  ).toBeVisible()
  await expect(page.getByText(/Good morning! It's wonderful/)).toBeVisible()

  await page.getByText('Processing a difficult week', { exact: true }).click()
  await expect(page.getByText(/Honestly, this week has been rough/)).toBeVisible()
})

test('Daily Chat searches message content fuzzily, folds diacritics, and clears results', async ({
  page,
}) => {
  await openDailyChat(page)
  const search = page.getByRole('searchbox', { name: 'Search conversations' })

  await search.fill('30minwalk')
  await expect(page.getByText('Goal-setting for the month', { exact: true })).toBeVisible()
  await expect(page.getByText('Morning reflections', { exact: true })).toHaveCount(0)

  await search.fill('dann')
  await expect(page.getByText('New chat', { exact: true }).first()).toBeVisible()

  await search.fill('zzzzzz')
  await expect(page.getByText('No conversations match your search.', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Clear conversation search' }).click()
  await expect(search).toHaveValue('')
  await expect(page.getByText('Morning reflections', { exact: true })).toBeVisible()
  await expect(page.getByText('Travel planning thoughts', { exact: true })).toBeVisible()
})

test('Clay Daily Chat matches the Entries tray + separated editor card', async ({ page }) => {
  await seedClay(page, 'dark')
  await openDailyChat(page)
  await expect(page.locator('html')).toHaveClass(/\bds-clay\b/)
  await page.getByText('Morning reflections', { exact: true }).click()

  const selectedTab = await tokenBackground(page, '--color-selected-tab')
  const elevated = await tokenBackground(page, '--color-elevated')
  const chatTray = page.locator('.xj-second-panel > div').first()
  const chatTranscript = page.locator('.xj-second-panel + div')
  await expect(chatTray).toBeVisible()
  await expect(chatTranscript).toBeVisible()
  await expect
    .poll(() => chatTray.evaluate((el) => getComputedStyle(el).backgroundColor))
    .toBe(selectedTab)
  await expect
    .poll(() => chatTranscript.evaluate((el) => getComputedStyle(el).backgroundColor))
    .toBe(elevated)

  const transcriptRadius = await chatTranscript.evaluate((el) => getComputedStyle(el).borderRadius)
  expect(Number.parseFloat(transcriptRadius)).toBeGreaterThan(16)

  const trayBox = await page.locator('.xj-second-panel').boundingBox()
  const transcriptBox = await chatTranscript.boundingBox()
  expect(trayBox).not.toBeNull()
  expect(transcriptBox).not.toBeNull()
  expect((transcriptBox?.x ?? 0) - ((trayBox?.x ?? 0) + (trayBox?.width ?? 0))).toBeGreaterThan(4)

  await page.getByRole('navigation').getByRole('button', { name: 'Entries', exact: true }).click()
  const entriesTray = page.locator('.xj-second-panel > div').first()
  const editorCard = page.locator('#xj-body-overlay-host > div').nth(1)
  await expect(entriesTray).toBeVisible()
  await expect
    .poll(() => entriesTray.evaluate((el) => getComputedStyle(el).backgroundColor))
    .toBe(selectedTab)
  await expect
    .poll(() => editorCard.evaluate((el) => getComputedStyle(el).backgroundColor))
    .toBe(elevated)
})
