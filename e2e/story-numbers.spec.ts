import { expect, test, type Locator, type Page } from '@playwright/test'

test.use({ reducedMotion: 'reduce' })

const THEME_OPTION_NAMES = ['Dark theme', 'Light theme'] as const

const DESIGN_SYSTEMS = [
  { radio: 'Signature design system', className: 'ds-signature' },
  { radio: 'Clean design system', className: 'ds-clean' },
  { radio: 'Switch to the Clay design system', className: 'ds-clay' },
] as const

async function openAppearance(page: Page) {
  await page.getByRole('navigation').getByRole('button', { name: 'Settings', exact: true }).click()
  await page.locator('#settings-tab-appearance').click()
  await expect(page.getByRole('radiogroup', { name: 'Design system' })).toBeVisible()
}

async function selectDesignSystem(page: Page, radioName: string, className: string) {
  const designSystem = page.getByRole('radiogroup', { name: 'Design system' })
  await designSystem.getByRole('radio', { name: radioName }).click()
  await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${className}\\b`))
}

async function selectTheme(page: Page, themeName: (typeof THEME_OPTION_NAMES)[number]) {
  const theme = page.getByRole('radiogroup', { name: 'Theme' })
  await theme.getByRole('radio', { name: themeName }).click()
  const html = page.locator('html')
  if (themeName === 'Dark theme') {
    await expect(html).toHaveClass(/\bdark\b/)
  } else {
    await expect(html).not.toHaveClass(/\bdark\b/)
  }
}

async function expectDashboardChips(page: Page) {
  await page.getByRole('navigation').getByRole('button', { name: 'Home', exact: true }).click()
  const grid = page.getByTestId('dashboard-grid')
  await expect(grid).toBeVisible()

  const cards = grid.locator('[data-card]:visible')
  await expect.poll(() => cards.count()).toBeGreaterThan(0)
  for (const card of await cards.all()) {
    await expect(card.locator('svg').first()).toBeAttached()
  }

  await expect(grid.locator('.tabular-nums').filter({ hasText: /\d/ }).first()).toBeVisible()
}

async function expectTileFigure(tile: Locator) {
  // Split bars inside the mood tile also use tabular-nums. The main figure
  // is the font-title numeral on the tile itself.
  const figure = tile.locator('> .font-title')
  await expect(figure).toHaveText(/\d/)
  await expect(figure).not.toHaveText('—')
}

async function expectStoryTiles(page: Page) {
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Statistics', exact: true })
    .click()
  const stats = page.getByTestId('statistics-view')
  await expect(stats).toBeVisible()

  const charts = stats.getByRole('radio', { name: 'Charts', exact: true })
  await charts.click()
  await expect(charts).toBeChecked()

  const tiles = stats.getByTestId('stat-tile')
  await expect(tiles).toHaveCount(6)
  for (const tile of await tiles.all()) {
    await expectTileFigure(tile)
  }
}

for (const skin of DESIGN_SYSTEMS) {
  test(`${skin.className} shows dashboard chips and six story tiles in light and dark`, async ({
    page,
  }) => {
    await page.goto('/?scenario=logged-in')

    for (const themeName of THEME_OPTION_NAMES) {
      await openAppearance(page)
      await selectDesignSystem(page, skin.radio, skin.className)
      await selectTheme(page, themeName)
      await expectDashboardChips(page)
      await expectStoryTiles(page)
    }
  })
}
