import { expect, test, type Page } from '@playwright/test'

const SOURCE = '/tmp/synthetic-apple-export'
const REPORT = '/tmp/memlore-apple-journal-import-report.txt'

async function openAppleImport(page: Page): Promise<void> {
  await page.goto('/?scenario=apple-journal-import')
  await expect(page.getByRole('heading', { name: 'Data', exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Import', exact: true })).toBeVisible()

  const format = page.getByRole('combobox', { name: 'Format', exact: true })
  await format.focus()
  await page.keyboard.press('Enter')
  const appleOption = page.getByRole('option', { name: 'Apple Journal (HTML folder)', exact: true })
  await expect(appleOption).toBeVisible()
  await appleOption.click()
  await expect(page.getByText('AppleJournalEntries', { exact: false })).toBeVisible()
  await expect(
    page.getByText('Import only merges into the selected journal', { exact: false }),
  ).toBeVisible()
  await expect(page.getByText('Date policy', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('radio', { name: /Replace all/ })).toHaveCount(0)
}

test('Apple Journal import shows honest fidelity and saves a report from the keyboard', async ({
  page,
}) => {
  await openAppleImport(page)

  const source = page.getByLabel('Source', { exact: true })
  await source.fill(SOURCE)

  const review = page.getByRole('button', { name: 'Review import', exact: true })
  await review.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Reviewing…', exact: true })).toBeVisible()

  const reviewDialog = page.getByRole('dialog', { name: 'Import review' })
  await expect(reviewDialog).toBeVisible()
  await expect(reviewDialog.getByText('4 entries in the export')).toBeVisible()
  await expect(reviewDialog.getByText('5 resources ready to import')).toBeVisible()
  await expect(reviewDialog.getByRole('button', { name: 'Close', exact: true })).toBeVisible()
  await expect(reviewDialog.getByRole('button', { name: 'Import', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Import', exact: true })).toHaveCount(1)

  await reviewDialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(reviewDialog).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Review again', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Import', exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: 'Review again', exact: true }).click()
  await expect(reviewDialog).toBeVisible()
  await reviewDialog.getByRole('button', { name: 'Import', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(reviewDialog.getByRole('button', { name: 'Importing…', exact: true })).toBeVisible()
  await expect(reviewDialog.getByRole('button', { name: 'Close', exact: true })).toBeDisabled()
  await expect(reviewDialog).toBeVisible()

  await expect(reviewDialog).toHaveCount(0)

  const resultDialog = page.getByRole('dialog', { name: 'Import results' })
  await expect(resultDialog).toBeVisible()
  const result = resultDialog.getByTestId('apple-import-result')
  await expect(result).toBeVisible()
  await expect(result.getByText('Preserved-only items are retained as provenance')).toBeVisible()
  await expect(result.getByText('They are not fully converted.')).toBeVisible()

  const entries = resultDialog.getByTestId('apple-fidelity-entries')
  await expect(entries.getByText('Converted (native): 2')).toBeVisible()
  await expect(entries.getByText('Preserved-only (not fully converted): 2')).toBeVisible()
  await expect(entries.getByText('Skipped exact duplicates: 1')).toBeVisible()
  await expect(entries.getByText('Failed: 0')).toBeVisible()

  const media = resultDialog.getByTestId('apple-fidelity-media')
  await expect(media.getByText('Converted (native): 5')).toBeVisible()
  await expect(media.getByText('Preserved-only (not fully converted): 1')).toBeVisible()
  await expect(media.getByText('Failed: 1')).toBeVisible()

  const metadata = resultDialog.getByTestId('apple-fidelity-metadata')
  await expect(metadata.getByText('Converted (native): 0')).toBeVisible()
  await expect(metadata.getByText('Preserved-only (not fully converted): 4')).toBeVisible()
  await expect(metadata.getByText('Failed: 1')).toBeVisible()

  await expect(result.getByText(/Native metadata/)).toBeVisible()
  await expect(result.getByText(/Retained as provenance only/)).toBeVisible()
  await expect(result.getByText(/synthetic local noon/)).toBeVisible()
  await expect(result.getByText(/unsupported visual styling/)).toBeVisible()
  await expect(result.getByText(/missing Live Photo motion/)).toBeVisible()
  await expect(result.getByText(/unsupported platform decoding/)).toBeVisible()
  await expect(result.getByText(/unknown metadata or cards/)).toBeVisible()
  await expect(result.getByText(/over a media upload limit/)).toBeVisible()
  await expect(result.getByText(/missing a source time or timezone/)).toBeVisible()

  await expect(page.getByText(/Dear diary|Sunset at home|secret\.heic/i)).toHaveCount(0)
  await expect(result.getByText(/preserved-only is fully converted/i)).toHaveCount(0)
  await expect(result.locator('script')).toHaveCount(0)
  await expect(result.getByText(/<script|javascript:|rawHtml|appleJournalImport/i)).toHaveCount(0)

  await expect(resultDialog.getByRole('button', { name: 'Save report', exact: true })).toBeVisible()
  await expect(resultDialog.getByRole('button', { name: 'Close', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save report…', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Import', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Review import', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Review again', exact: true })).toHaveCount(0)

  await resultDialog.getByRole('button', { name: 'Save report', exact: true }).focus()
  await page.keyboard.press('Enter')

  const saveDialog = page.getByRole('dialog', { name: 'Save import report' })
  await expect(saveDialog).toBeVisible()
  const dest = saveDialog.getByLabel('Report location', { exact: true })
  await expect(dest).toBeFocused()
  await dest.fill(REPORT)
  await saveDialog.getByRole('button', { name: 'Save report', exact: true }).focus()
  await page.keyboard.press('Enter')

  await expect(saveDialog).toHaveCount(0)
  await expect(resultDialog).toBeVisible()
  await expect(resultDialog.getByTestId('apple-report-saved')).toHaveText('Report saved')

  await resultDialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(resultDialog).toHaveCount(0)
  await expect(page.getByTestId('apple-import-result')).toHaveCount(0)
  await expect(page.getByTestId('apple-report-saved')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Save report', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Review import', exact: true })).toBeVisible()
  await expect(source).toHaveValue(SOURCE)
})
