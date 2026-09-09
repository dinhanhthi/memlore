import { expect, test, type Page } from '@playwright/test'

const SAVE_BODY = 'I felt the nerves ease after talking the Q&A through.'
const APPEND_BODY = 'The append-once lantern phrase stays unique.'

async function openChat(page: Page): Promise<void> {
  await page.getByRole('navigation').getByRole('button', { name: 'Chat', exact: true }).click()
}

async function selectMorningReflections(page: Page): Promise<void> {
  await page.getByRole('complementary').getByText('Morning reflections', { exact: true }).click()
}

async function openMorningReflections(page: Page): Promise<void> {
  await page.goto('/?scenario=ai-connected')
  await openChat(page)
  await selectMorningReflections(page)
}

function editor(page: Page) {
  return page.locator('.ProseMirror')
}

async function countInEditor(page: Page, phrase: string): Promise<number> {
  const text = await editor(page).innerText()
  return text.split(phrase).length - 1
}

test('save as entry then update appends once and survives reopen', async ({ page }) => {
  await openMorningReflections(page)

  await page.getByRole('button', { name: 'Save as entry', exact: true }).click()
  await expect(page.getByText('Save as journal entry', { exact: true })).toBeVisible()
  const draft = page.getByRole('textbox', { name: 'Edit', exact: true })
  await expect(draft).toHaveValue(new RegExp(SAVE_BODY))
  await page.getByRole('button', { name: 'Save entry', exact: true }).click()

  await expect(editor(page)).toContainText(SAVE_BODY)
  await expect(page.getByText('Saved', { exact: true }).first()).toBeVisible({ timeout: 10_000 })

  await openChat(page)
  await selectMorningReflections(page)

  const update = page.getByRole('button', { name: 'Update the entry', exact: true })
  await expect(update).toBeEnabled()
  await update.click()
  await expect(page.getByText('Update your journal entry', { exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Edit', exact: true })).toHaveValue(APPEND_BODY)
  await page.getByRole('button', { name: 'Update entry', exact: true }).click()

  await expect(editor(page)).toContainText(SAVE_BODY)
  await expect(editor(page)).toContainText(APPEND_BODY)
  expect(await countInEditor(page, APPEND_BODY)).toBe(1)
  await expect(page.getByText('Saved', { exact: true }).first()).toBeVisible({ timeout: 10_000 })

  await openChat(page)
  await selectMorningReflections(page)
  await page.getByRole('button', { name: 'Open the generated entry', exact: true }).click()

  await expect(editor(page)).toContainText(SAVE_BODY)
  await expect(editor(page)).toContainText(APPEND_BODY)
  expect(await countInEditor(page, APPEND_BODY)).toBe(1)
})
