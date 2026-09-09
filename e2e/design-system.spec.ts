import { expect, test, type Page } from '@playwright/test'

test.use({ reducedMotion: 'reduce' })

const THEME_OPTION_NAMES = ['Light theme', 'Dark theme'] as const

/** Body canvas must resolve to the live `--color-app` token (not a snapshot hex). */
async function expectBodyUsesColorApp(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const body = getComputedStyle(document.body).backgroundColor
        const probe = document.createElement('div')
        probe.style.backgroundColor = 'var(--color-app)'
        document.body.append(probe)
        const token = getComputedStyle(probe).backgroundColor
        probe.remove()
        return body === token
      }),
    )
    .toBe(true)
}

test('Clean design system unlocks theme and drops Surface', async ({ page }) => {
  await page.goto('/?scenario=settings-security-no-pw')
  await page.locator('#settings-tab-appearance').click()

  const html = page.locator('html')
  const designSystem = page.getByRole('radiogroup', { name: 'Design system' })
  const theme = page.getByRole('radiogroup', { name: 'Theme' })
  const surface = page.getByRole('radiogroup', { name: 'Surface style' })

  await expect(designSystem).toBeVisible()

  // Signature + dark on first load (default theme); theme radios enabled
  await expect(html).toHaveClass(/\bds-signature\b/)
  await expect(html).toHaveClass(/\bdark\b/)
  for (const name of THEME_OPTION_NAMES) {
    await expect(theme.getByRole('radio', { name })).toBeEnabled()
  }
  await expect(theme.getByRole('radio')).toHaveCount(2)
  await expect(theme.getByRole('radio', { name: 'Match system' })).toHaveCount(0)

  // Surface still visible under Signature (Deep, Soft, Lumen)
  await expect(surface).toBeVisible()
  await expect(surface.getByRole('radio')).toHaveCount(3)

  // Clean drops Surface and keeps theme enabled
  await designSystem.getByRole('radio', { name: 'Clean design system' }).click()
  await expect(html).toHaveClass(/\bds-clean\b/)
  await expect(html).not.toHaveClass(/\bds-signature\b/)
  for (const name of THEME_OPTION_NAMES) {
    await expect(theme.getByRole('radio', { name })).toBeEnabled()
  }

  await expect(surface).toHaveCount(0)

  // Clean light paints the shipping --color-app canvas.
  await theme.getByRole('radio', { name: 'Light theme' }).click()
  await expect(html).not.toHaveClass(/\bdark\b/)
  await expectBodyUsesColorApp(page)

  // Light → Signature: Surface visible and locked; theme stays enabled
  await designSystem.getByRole('radio', { name: 'Signature design system' }).click()
  await expect(html).toHaveClass(/\bds-signature\b/)
  await expect(html).not.toHaveClass(/\bdark\b/)
  await expect(surface).toBeVisible()
  await expect(surface).toHaveAttribute('aria-disabled', 'true')
  for (const radio of await surface.getByRole('radio').all()) {
    await expect(radio).toBeDisabled()
  }
  for (const name of THEME_OPTION_NAMES) {
    await expect(theme.getByRole('radio', { name })).toBeEnabled()
  }

  // Round-trip back to Clean: Surface gone; light preference survives
  await designSystem.getByRole('radio', { name: 'Clean design system' }).click()
  await expect(surface).toHaveCount(0)

  // Light preference survives the Signature round-trip
  await expect(html).toHaveClass(/\bds-clean\b/)
  await expect(html).not.toHaveClass(/\bdark\b/)

  // (e) reload preserves ds-clean with no dark class on first paint
  await expect
    .poll(() =>
      page.evaluate(() => {
        try {
          const raw = localStorage.getItem('memlore-ui')
          const p = (raw ? JSON.parse(raw) : {}).state as {
            designSystem?: string
            theme?: string
          }
          return p.designSystem === 'clean' && p.theme === 'light'
        } catch {
          return false
        }
      }),
    )
    .toBe(true)

  await page.reload({ waitUntil: 'domcontentloaded' })
  const firstPaintClasses = await page.evaluate(() => [...document.documentElement.classList])
  expect(firstPaintClasses).toContain('ds-clean')
  expect(firstPaintClasses).not.toContain('dark')
})

test('Signature dark Lumen stamps surface-lumen and not surface-soft', async ({ page }) => {
  await page.goto('/?scenario=settings-security-no-pw')
  await page.locator('#settings-tab-appearance').click()

  const html = page.locator('html')
  const surface = page.getByRole('radiogroup', { name: 'Surface style' })

  await expect(html).toHaveClass(/\bds-signature\b/)
  await expect(html).toHaveClass(/\bdark\b/)
  await expect(surface).toBeVisible()

  // Deep (default) is XOR with Lumen: no leftover surface-lumen class
  await surface.getByRole('radio', { name: 'Deep charcoal surfaces' }).click()
  await expect(html).not.toHaveClass(/\bsurface-lumen\b/)

  await surface.getByRole('radio', { name: 'Lumen dark Night Foundry surfaces' }).click()
  await expect(html).toHaveClass(/\bsurface-lumen\b/)
  await expect(html).toHaveClass(/\bds-signature\b/)
  await expect(html).toHaveClass(/\bdark\b/)
  await expect(html).not.toHaveClass(/\bsurface-soft\b/)
})

test('Clay design system unlocks theme, drops Surface, and persists on reload', async ({
  page,
}) => {
  await page.goto('/?scenario=settings-security-no-pw')
  await page.locator('#settings-tab-appearance').click()

  const html = page.locator('html')
  const designSystem = page.getByRole('radiogroup', { name: 'Design system' })
  const theme = page.getByRole('radiogroup', { name: 'Theme' })
  const surface = page.getByRole('radiogroup', { name: 'Surface style' })

  await expect(designSystem).toBeVisible()

  // Clay aria is action-phrased (Signature/Clean stay noun-phrased).
  const clayRadio = designSystem.getByRole('radio', { name: 'Switch to the Clay design system' })
  await expect(clayRadio).toHaveText('Clay')
  await clayRadio.click()

  await expect(html).toHaveClass(/\bds-clay\b/)
  await expect(html).not.toHaveClass(/\bds-clean\b/)
  await expect(html).not.toHaveClass(/\bds-signature\b/)

  // Surface is Signature-only — Clay hides the radiogroup like Clean.
  await expect(surface).toHaveCount(0)

  // Clay ships light + dark; theme radios stay enabled.
  for (const name of THEME_OPTION_NAMES) {
    await expect(theme.getByRole('radio', { name })).toBeEnabled()
  }

  // Clay light paints --color-app paper.
  await theme.getByRole('radio', { name: 'Light theme' }).click()
  await expect(html).not.toHaveClass(/\bdark\b/)
  await expectBodyUsesColorApp(page)

  // Clay dark paper.
  await theme.getByRole('radio', { name: 'Dark theme' }).click()
  await expect(html).toHaveClass(/\bdark\b/)
  await expectBodyUsesColorApp(page)

  // Leave light so first-paint reload matches the Clean light pattern.
  await theme.getByRole('radio', { name: 'Light theme' }).click()
  await expect(html).not.toHaveClass(/\bdark\b/)
  await expectBodyUsesColorApp(page)

  await expect
    .poll(() =>
      page.evaluate(() => {
        try {
          const raw = localStorage.getItem('memlore-ui')
          const p = (raw ? JSON.parse(raw) : {}).state as {
            designSystem?: string
            theme?: string
          }
          return p.designSystem === 'clay' && p.theme === 'light'
        } catch {
          return false
        }
      }),
    )
    .toBe(true)

  await page.reload({ waitUntil: 'domcontentloaded' })
  const firstPaintClasses = await page.evaluate(() => [...document.documentElement.classList])
  expect(firstPaintClasses).toContain('ds-clay')
  expect(firstPaintClasses).not.toContain('dark')
})
