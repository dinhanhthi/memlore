import { expect, test, type Page } from '@playwright/test'

async function openAIFeatures(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem(
      'memlore-ui',
      JSON.stringify({ state: { addedProviders: ['ollama'] }, version: 0 }),
    )
  })
  await page.goto('/?scenario=ai-connected')
  await page.getByRole('navigation').getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: 'AI', exact: true }).click()
  await page.getByRole('tab', { name: 'Features', exact: true }).click()
}

test('default AI feature prompt stays collapsed until customization is requested', async ({
  page,
}) => {
  await openAIFeatures(page)

  const featuresPanel = page.getByRole('tabpanel', { name: 'Features' })

  await featuresPanel.getByRole('button', { name: /^Title Generation/ }).click()

  await expect(
    featuresPanel.getByText('Using default prompt', { exact: true }).first(),
  ).toBeVisible()
  await expect(featuresPanel.locator('textarea')).toHaveCount(0)

  const customizePrompt = featuresPanel
    .getByRole('button', { name: 'Customize prompt', exact: true })
    .or(featuresPanel.getByRole('link', { name: 'Customize prompt', exact: true }))
  await expect(customizePrompt.first()).toBeVisible()
  await customizePrompt.first().click()

  const titlePrompt = featuresPanel.getByRole('textbox', {
    name: 'Custom prompt for Title Generation',
  })
  await expect(titlePrompt).toBeVisible()

  const customPrompt = 'Return a vivid three-word title.'
  await titlePrompt.fill(customPrompt)
  await featuresPanel.getByRole('button', { name: 'Save prompt', exact: true }).click()

  await page
    .getByRole('tablist', { name: 'Settings categories' })
    .getByRole('tab', { name: 'General', exact: true })
    .click()
  await page.getByRole('tab', { name: 'AI', exact: true }).click()
  await page.getByRole('tab', { name: 'Features', exact: true }).click()
  await featuresPanel.getByRole('button', { name: /^Title Generation/ }).click()

  await expect(featuresPanel.getByText('Using custom prompt', { exact: true })).toBeVisible()
  await expect(titlePrompt).toHaveValue(customPrompt)

  await featuresPanel.getByRole('button', { name: 'Reset to default', exact: true }).click()

  await expect(
    featuresPanel.getByText('Using default prompt', { exact: true }).first(),
  ).toBeVisible()
  await expect(featuresPanel.locator('textarea')).toHaveCount(0)
})
