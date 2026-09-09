import { expect, test } from '@playwright/test'

test('footer shows the shared AI provider snapshot and restores focus after Escape', async ({
  page,
}) => {
  await page.goto('/?scenario=logged-in')

  const trigger = page.getByRole('button', { name: 'AI settings', exact: true })
  const streak = page.getByTestId('footer-streak')
  await expect(trigger).toBeVisible()
  await expect(trigger).toContainText('AI')

  await expect
    .poll(async () => {
      const [triggerBox, streakBox] = await Promise.all([
        trigger.boundingBox(),
        streak.boundingBox(),
      ])
      if (!triggerBox || !streakBox) return false
      return triggerBox.x + triggerBox.width <= streakBox.x
    })
    .toBe(true)

  await trigger.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Current AI settings' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('OpenAI', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Voyage AI', { exact: true })).toBeVisible()
  await expect(dialog.getByText('gpt-5-mini', { exact: true })).toBeVisible()
  await expect(dialog.getByText('gpt-image-2', { exact: true })).toBeVisible()
  await expect(dialog.getByText('voyage-4', { exact: true })).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test('ai-connected keeps its Ollama provider override', async ({ page }) => {
  await page.goto('/?scenario=ai-connected')

  const trigger = page.getByRole('button', { name: 'AI settings', exact: true })
  await trigger.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Current AI settings' })

  await expect(dialog.getByText('Ollama', { exact: true })).toHaveCount(2)
  await expect(dialog.getByText('qwen3.5:4b', { exact: true })).toBeVisible()
  await expect(dialog.getByText('nomic-embed-text', { exact: true })).toBeVisible()
  await expect(dialog.getByText('gpt-5-mini', { exact: true })).toHaveCount(0)
  await expect(dialog.getByText('voyage-4', { exact: true })).toHaveCount(0)
})

test('same-page scenario switch rehydrates the footer provider snapshot', async ({ page }) => {
  await page.goto('/?scenario=logged-in')

  const trigger = page.getByRole('button', { name: 'AI settings', exact: true })
  await trigger.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Current AI settings' })).toContainText('OpenAI')
  await page.keyboard.press('Escape')

  await page
    .getByTestId('scenario-picker')
    .getByRole('button', { name: 'AI: connected', exact: true })
    .click()
  await expect(page).toHaveURL(/scenario=ai-connected/)

  const nextTrigger = page.getByRole('button', { name: 'AI settings', exact: true })
  await nextTrigger.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Current AI settings' })
  await expect(dialog.getByText('Ollama', { exact: true })).toHaveCount(2)
  await expect(dialog.getByText('OpenAI', { exact: true })).toHaveCount(0)
  await expect(dialog.getByText('Voyage AI', { exact: true })).toHaveCount(0)
})
