import { expect, test, type Locator } from '@playwright/test'
import { titlebarRowHeight } from '../src/lib/windowChrome'

async function expectPinnedToBodyHost(locator: Locator) {
  await expect(locator).toBeVisible()
  const match = await locator.evaluate((el) => {
    const host = document.getElementById('xj-body-overlay-host')
    if (!host) return false
    const a = el.getBoundingClientRect()
    const b = host.getBoundingClientRect()
    return (
      Math.abs(a.top - b.top) <= 1 &&
      Math.abs(a.left - b.left) <= 1 &&
      Math.abs(a.width - b.width) <= 1 &&
      Math.abs(a.height - b.height) <= 1
    )
  })
  expect(match).toBe(true)
}

async function expectDoesNotCoverChrome(page: import('@playwright/test').Page, overlay: Locator) {
  const [overlayBox, sidebarBox] = await Promise.all([
    overlay.boundingBox(),
    page.getByRole('complementary').boundingBox(),
  ])
  expect(overlayBox).toBeTruthy()
  expect(sidebarBox).toBeTruthy()
  if (!overlayBox || !sidebarBox) return

  const overlapsSidebar =
    overlayBox.x < sidebarBox.x + sidebarBox.width &&
    overlayBox.x + overlayBox.width > sidebarBox.x &&
    overlayBox.y < sidebarBox.y + sidebarBox.height &&
    overlayBox.y + overlayBox.height > sidebarBox.y
  expect(overlapsSidebar).toBe(false)

  // The body card starts below the Signature titlebar row.
  expect(overlayBox.y).toBeGreaterThanOrEqual(titlebarRowHeight('signature'))
}

test.use({ contextOptions: { reducedMotion: 'reduce' } })

test('command palette modal stays inside the body overlay host', async ({ page }) => {
  await page.goto('/?scenario=logged-in')

  await page.getByRole('button', { name: 'Command palette', exact: true }).click()
  const scrim = page.locator('[data-modal-scrim="true"]')
  await expectPinnedToBodyHost(scrim)
  await expectDoesNotCoverChrome(page, scrim)
  await expect(page.getByRole('dialog', { name: 'Search commands…' })).toBeVisible()
})

test('search overlay stays inside the body overlay host', async ({ page }) => {
  await page.goto('/?scenario=logged-in')

  await page.getByRole('button', { name: 'Search', exact: true }).click()
  const overlay = page.getByRole('dialog', { name: 'Search' })
  await expectPinnedToBodyHost(overlay)
  await expectDoesNotCoverChrome(page, overlay)
})
