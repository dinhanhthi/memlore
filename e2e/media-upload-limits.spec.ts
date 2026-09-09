import { expect, test, type Page } from '@playwright/test'

async function openUploadLimits(page: Page): Promise<void> {
  await page.goto('/?scenario=settings-security-no-pw')
  await page
    .getByRole('tablist', { name: 'Settings categories' })
    .getByRole('tab', { name: 'Media', exact: true })
    .click()
  const limits = page.getByTestId('media-upload-limits')
  await expect(limits).toBeVisible()
  await limits.scrollIntoViewIfNeeded()
}

function photoMb(page: Page) {
  return page.locator('#upload-photo-mb')
}

function photoUnlimited(page: Page) {
  return page.getByTestId('media-upload-limits').getByRole('checkbox').nth(0)
}

function videoUnlimited(page: Page) {
  return page.getByTestId('media-upload-limits').getByRole('checkbox').nth(1)
}

test('rejected upload-limit write rolls the optimistic value back', async ({ page }) => {
  await openUploadLimits(page)
  const input = photoMb(page)
  await expect(input).toHaveValue('10')

  await input.fill('13')
  await expect(page.getByRole('alert')).toHaveText('upload limit rejected')
  await expect(input).toHaveValue('10')
})

test('stale upload-limit responses do not clobber the newest typed value', async ({ page }) => {
  await openUploadLimits(page)
  const input = photoMb(page)
  await expect(input).toHaveValue('10')

  await input.click()
  await input.press('ControlOrMeta+a')
  await input.pressSequentially('250', { delay: 40 })

  await expect(input).toHaveValue('250', { timeout: 8_000 })
})

test('both-unlimited warning fires on the transition only', async ({ page }) => {
  await openUploadLimits(page)

  await photoUnlimited(page).check()
  await expect(page.getByText('Both limits are unlimited', { exact: true })).toHaveCount(0)

  await videoUnlimited(page).check()
  const warning = page.getByText('Both limits are unlimited', { exact: true })
  await expect(warning).toBeVisible()
  await page.getByRole('button', { name: 'Got it', exact: true }).click()
  await expect(warning).toHaveCount(0)

  await page
    .getByRole('tablist', { name: 'Settings categories' })
    .getByRole('tab', { name: 'Appearance', exact: true })
    .click()
  await page
    .getByRole('tablist', { name: 'Settings categories' })
    .getByRole('tab', { name: 'Media', exact: true })
    .click()
  await expect(page.getByTestId('media-upload-limits')).toBeVisible()
  await expect(page.getByText('Both limits are unlimited', { exact: true })).toHaveCount(0)
})
