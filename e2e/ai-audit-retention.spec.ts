import { expect, test } from '@playwright/test'

test('AI audit uses predefined retention and keeps the table header pinned', async ({ page }) => {
  await page.goto('/?scenario=stats-ai-audit')
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Statistics', exact: true })
    .click()
  await page.getByRole('radio', { name: 'AI audit log', exact: true }).click()

  const retention = page.getByRole('radiogroup', { name: 'Keep entries for' })

  await expect(retention).toBeVisible()
  await expect(retention.getByRole('radio')).toHaveCount(4)
  await expect(retention.getByText('1mo', { exact: true })).toBeVisible()
  await expect(retention.getByText('3mo', { exact: true })).toBeVisible()
  await expect(retention.getByText('6mo', { exact: true })).toBeVisible()
  await expect(retention.getByText('1y', { exact: true })).toBeVisible()
  await expect(retention.getByRole('radio', { name: '3 months', exact: true })).toBeChecked()
  await expect(page.locator('input[type="range"]')).toHaveCount(0)

  const privacyFooter = page.getByTestId('ai-audit-privacy-footer')
  await expect(privacyFooter.getByText('Privacy:', { exact: true })).toBeVisible()
  await expect(privacyFooter).toContainText('Privacy: we never store call content — only metadata.')
  await expect(privacyFooter.locator('svg')).toBeVisible()

  const tableScroller = page.getByTestId('ai-audit-table-scroll')
  const tableHeader = page.getByTestId('ai-audit-table-header')

  await expect
    .poll(() => tableScroller.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true)

  await tableScroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })

  await expect.poll(() => tableScroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)

  await expect
    .poll(async () => {
      const [scrollerBox, headerBox, clientTop] = await Promise.all([
        tableScroller.boundingBox(),
        tableHeader.boundingBox(),
        tableScroller.evaluate((element) => element.clientTop),
      ])
      if (!scrollerBox || !headerBox) return Number.POSITIVE_INFINITY
      return Math.abs(headerBox.y - scrollerBox.y - clientTop)
    })
    .toBeLessThan(1)

  const headerCellAlphas = await tableHeader.getByRole('columnheader').evaluateAll((cells) => {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const context = canvas.getContext('2d')
    if (!context) return []

    return cells.map((cell) => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = getComputedStyle(cell).backgroundColor
      context.fillRect(0, 0, 1, 1)
      return context.getImageData(0, 0, 1, 1).data[3]
    })
  })
  expect(headerCellAlphas).toEqual([255, 255, 255, 255, 255, 255, 255])
})
