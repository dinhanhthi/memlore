import { expect, test, type Locator } from '@playwright/test'

const CLOCK_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/

async function verticalGap(upper: Locator, lower: Locator): Promise<number | null> {
  const [upperBox, lowerBox] = await Promise.all([upper.boundingBox(), lower.boundingBox()])
  if (!upperBox || !lowerBox) return null
  return lowerBox.y - (upperBox.y + upperBox.height)
}

test('logged-in entry cards use compact metadata dots, tag bars, and roomier rows', async ({
  page,
}) => {
  await page.goto('/?scenario=logged-in')
  await page.getByRole('navigation').getByRole('button', { name: 'Entries', exact: true }).click()

  const title = page.getByText('A fresh start', { exact: true })
  await expect(title).toBeVisible()

  const card = page.locator('[role="button"]').filter({ has: title }).first()
  const groupHeader = page.locator('.sticky.top-0').first()
  const journalMarker = card.getByLabel('Journal: Daily Journal', { exact: true })
  const timeLabel = card.locator('span').filter({ hasText: CLOCK_TIME }).first()
  const moodMarker = card.getByLabel('Mood: good', { exact: true })
  const description = card.getByText(
    'Woke up early and felt genuinely optimistic about the week ahead. Made coffee and sat on the balcony watching the sunrise.',
    { exact: true },
  )
  const tagList = card.getByRole('list', { name: 'Tags' })
  const gratitudeTag = tagList.getByRole('listitem').first()

  await expect.soft(groupHeader.getByText(/^\d+ entries?$/)).toHaveCount(0, { timeout: 500 })

  const cardTextFragments = await card.locator('span').allTextContents()
  expect.soft(cardTextFragments.filter((text) => CLOCK_TIME.test(text.trim()))).toHaveLength(1)
  await expect.soft(card.getByText('Daily Journal', { exact: true })).toBeVisible({ timeout: 500 })

  const moodPresentation = await moodMarker.evaluate((element) => {
    const style = getComputedStyle(element)
    const box = element.getBoundingClientRect()
    return {
      backgroundColor: style.backgroundColor,
      borderRadius: style.borderRadius,
      height: box.height,
      text: element.textContent?.trim() ?? '',
      width: box.width,
    }
  })
  expect.soft(moodPresentation.text).toBe('')
  expect.soft(moodPresentation.width).toBe(moodPresentation.height)
  expect.soft(moodPresentation.width).toBeLessThanOrEqual(12)
  expect.soft(moodPresentation.backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
  expect
    .soft(parseFloat(moodPresentation.borderRadius))
    .toBeGreaterThanOrEqual(moodPresentation.width / 2)

  const tagPresentation = await gratitudeTag.evaluate((element) => {
    const style = getComputedStyle(element)
    const box = element.getBoundingClientRect()
    return {
      backgroundColor: style.backgroundColor,
      height: box.height,
      text: element.textContent?.trim() ?? '',
      width: box.width,
    }
  })
  expect.soft(await gratitudeTag.getAttribute('aria-label')).toBe('gratitude')
  expect.soft(tagPresentation.text).toBe('')
  expect.soft(tagPresentation.backgroundColor).toBe('rgb(245, 158, 11)')
  expect.soft(tagPresentation.width / tagPresentation.height).toBeCloseTo(2, 1)

  await gratitudeTag.hover()
  await expect
    .soft(page.getByRole('tooltip', { name: 'gratitude' }))
    .toBeVisible({ timeout: 1_000 })

  await expect.soft(journalMarker).toBeVisible()
  await expect.soft(description).toBeVisible()
  const [timeFontSize, journalFontSize] = await Promise.all([
    timeLabel.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
    journalMarker.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
  ])
  await expect.soft(timeLabel).toHaveClass(/\btext-2xs\b/, { timeout: 500 })
  await expect.soft(journalMarker).toHaveClass(/\btext-2xs\b/, { timeout: 500 })
  // text-2xs (0.75rem = 12px on the 16px root) must stay below text-xs (0.8125rem = 13px).
  expect.soft(timeFontSize).toBeLessThan(13)
  expect.soft(journalFontSize).toBeLessThan(13)

  const dayHeaderPresentation = await groupHeader.evaluate((element) => {
    const base = getComputedStyle(element)
    const overlay = getComputedStyle(element, '::before')
    return {
      baseBackgroundColor: base.backgroundColor,
      overlayBackgroundImage: overlay.backgroundImage,
      overlayContent: overlay.content,
    }
  })
  expect.soft(dayHeaderPresentation.baseBackgroundColor).not.toBe('rgba(0, 0, 0, 0)')
  expect.soft(dayHeaderPresentation.baseBackgroundColor).not.toBe('transparent')
  expect.soft(dayHeaderPresentation.overlayContent).not.toBe('none')
  expect.soft(dayHeaderPresentation.overlayBackgroundImage).toContain('linear-gradient')
  expect.soft(dayHeaderPresentation.overlayBackgroundImage).toMatch(/(?:90deg|to right)/)

  const [headerToTitle, titleToDescription, descriptionToFooter] = await Promise.all([
    verticalGap(journalMarker, title),
    verticalGap(title, description),
    verticalGap(description, tagList),
  ])
  expect.soft(headerToTitle).not.toBeNull()
  expect.soft(titleToDescription).not.toBeNull()
  expect.soft(descriptionToFooter).not.toBeNull()
  expect.soft(headerToTitle ?? 0).toBeGreaterThanOrEqual(8)
  expect.soft(titleToDescription ?? 0).toBeGreaterThanOrEqual(8)
  expect.soft(descriptionToFooter ?? 0).toBeGreaterThanOrEqual(8)

  const mediaTitle = page.getByText('Arrived in Lisbon', { exact: true })
  const mediaCard = page.locator('[role="button"]').filter({ has: mediaTitle }).first()
  await expect.soft(mediaCard).toBeVisible()
  await expect.soft(mediaCard.locator('.xj-media-count-badge')).toHaveCount(0, { timeout: 500 })
  await expect
    .soft(mediaCard.getByLabel(/\d+ media attachments?/i))
    .toHaveCount(0, { timeout: 500 })
})

test('AI summary control is icon-only while retaining its accessible name', async ({ page }) => {
  await page.goto('/?scenario=ai-connected')
  await page.getByRole('navigation').getByRole('button', { name: 'Entries', exact: true }).click()

  const trigger = page.getByRole('button', { name: 'AI summary', exact: true }).first()
  await expect(trigger).toBeVisible()
  await expect(trigger).toHaveText('', { timeout: 500 })
  await expect.soft(trigger.locator('svg.lucide-sparkles')).toBeVisible({ timeout: 500 })
  await expect.soft(trigger.locator('canvas')).toHaveCount(0, { timeout: 500 })

  const box = await trigger.boundingBox()
  expect(box).not.toBeNull()
  expect(box?.width).toBe(box?.height)
})
