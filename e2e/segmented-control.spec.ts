import { expect, test } from '@playwright/test'

test.use({ reducedMotion: 'reduce' })

test('selected SegmentedControl pill matches the selected option bounds', async ({ page }) => {
  await page.goto('/?scenario=settings-security-no-pw')
  await page.locator('#settings-tab-appearance').click()

  const group = page.getByRole('radiogroup', { name: 'Surface style' })
  await group.getByRole('radio', { name: 'Deep charcoal surfaces' }).click()
  const selectedOption = group.getByRole('radio', { checked: true })
  const indicator = group.locator('span[aria-hidden]')

  await expect(group).toBeVisible()
  await expect(indicator).toBeVisible()

  await expect
    .poll(async () => {
      const [optionBox, indicatorBox] = await Promise.all([
        selectedOption.boundingBox(),
        indicator.boundingBox(),
      ])
      if (!optionBox || !indicatorBox) return Number.POSITIVE_INFINITY
      return Math.max(
        Math.abs(indicatorBox.x - optionBox.x),
        Math.abs(indicatorBox.y - optionBox.y),
        Math.abs(indicatorBox.width - optionBox.width),
        Math.abs(indicatorBox.height - optionBox.height),
      )
    })
    // Thumb is `transform-gpu`; getBoundingClientRect can land a subpixel off
    // the option after sidebar/layout shifts (Dashboard nav item).
    .toBeLessThan(1)
})
