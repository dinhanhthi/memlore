import { expect, test, type Page } from '@playwright/test'

async function expectCatchupNoticeAtPageFooter(
  page: Page,
  viewTestId: string,
  borderTopWidth = '1px',
) {
  const footer = page.getByRole('status').filter({ hasText: 'Figures are still filling in' })
  await expect(footer).toBeVisible()

  await expect
    .poll(() =>
      footer.evaluate((element) => {
        const styles = getComputedStyle(element)
        return {
          backgroundColor: styles.backgroundColor,
          borderTopWidth: styles.borderTopWidth,
          borderRightWidth: styles.borderRightWidth,
          borderBottomWidth: styles.borderBottomWidth,
          borderLeftWidth: styles.borderLeftWidth,
        }
      }),
    )
    .toEqual({
      backgroundColor: 'rgba(0, 0, 0, 0)',
      borderTopWidth,
      borderRightWidth: '0px',
      borderBottomWidth: '0px',
      borderLeftWidth: '0px',
    })

  await expect
    .poll(async () => {
      const [footerBox, pageBox] = await Promise.all([
        footer.boundingBox(),
        page.getByTestId(viewTestId).boundingBox(),
      ])
      if (!footerBox || !pageBox) return Number.POSITIVE_INFINITY
      return Math.abs(footerBox.y + footerBox.height - pageBox.y - pageBox.height)
    })
    .toBeLessThan(32)
}

test('aggregate views keep the sync catch-up notice in their fixed footer', async ({ page }) => {
  await page.goto('/?scenario=logged-in')

  const navigation = page.getByRole('navigation')

  await navigation.getByRole('button', { name: 'Statistics', exact: true }).click()
  await expectCatchupNoticeAtPageFooter(page, 'statistics-view')

  await navigation.getByRole('button', { name: 'Lookback', exact: true }).click()
  await expectCatchupNoticeAtPageFooter(page, 'on-this-day-view')

  await navigation.getByRole('button', { name: 'Locations', exact: true }).click()
  await expectCatchupNoticeAtPageFooter(page, 'locations-map-view', '0px')
})
