import { expect, test } from '@playwright/test'

test.use({ contextOptions: { reducedMotion: 'reduce' } })

test('collapsed sidebar is w-12 (3rem) wide', async ({ page }) => {
  await page.goto('/?scenario=logged-in')

  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()

  const sidebar = page.getByRole('complementary')
  const shell = sidebar.locator('..')

  await expect
    .poll(async () => {
      const [sidebarBox, shellBox] = await Promise.all([sidebar.boundingBox(), shell.boundingBox()])
      return [sidebarBox?.width, shellBox?.width]
    })
    // Root font-size is 16px (`globals.css`), so Tailwind `w-12` (3rem) is 48px.
    .toEqual([48, 48])
})

test('sidebar shows a primary New Entry button', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  await page.goto('/?scenario=logged-in')

  const newEntryButton = page.getByRole('button', { name: 'New Entry', exact: true })
  await expect(newEntryButton).toBeVisible()
  await expect(newEntryButton).toHaveClass(/gradient-primary/)
  await expect(newEntryButton.locator('svg')).toHaveClass(/lucide-pen-line/)

  const sidebar = page.getByRole('complementary')
  await sidebar.getByRole('button', { name: 'Settings', exact: true }).click()
  await newEntryButton.click()
  await expect(sidebar.getByRole('button', { name: 'Entries', exact: true })).toHaveClass(
    /bg-elevated/,
  )
  await expect(page.getByPlaceholder('Title')).toHaveValue('A fresh start')
  expect(consoleErrors).not.toContainEqual(expect.stringContaining('Failed to create entry'))

  const newEntryLabel = newEntryButton.getByText('New Entry', { exact: true })
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
  await expect(newEntryLabel).toHaveCount(1)
  await expect(newEntryLabel).toHaveCSS('max-width', '0px')
  await expect(newEntryLabel).toHaveCSS('opacity', '0')
  await expect
    .poll(async () => {
      const iconBox = await newEntryButton.locator('svg').boundingBox()
      return [iconBox?.width, iconBox?.height]
    })
    .toEqual([16, 16])
})
