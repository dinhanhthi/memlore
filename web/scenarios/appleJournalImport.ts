import { useTabStore } from '../../src/stores/tabStore'
import type { AppleJournalImportPreview, ImportSummary } from '../../src/lib/tauri'
import type { Scenario } from './types'

/** Synthetic Apple Journal preflight. Counts only — no private export text. */
export const APPLE_JOURNAL_IMPORT_PREVIEW: AppleJournalImportPreview = {
  sourceHash: 'synthetic-hash-001',
  conversionTimezone: 'Europe/Berlin',
  datePolicy: 'html_visible',
  datePrecision: 'date_only',
  clockIsSynthetic: true,
  entries: 4,
  resourcesReferenced: 6,
  resourcesWouldImport: 5,
  resourcesMissing: 1,
  resourcesUnsupported: 0,
  resourcesUnreferenced: 0,
  warnings: [
    {
      kind: 'preserved_only',
      feature: 'font-color',
      message: 'font colour retained in source metadata',
    },
    {
      kind: 'preserved_only',
      feature: 'font-color',
      message: 'font colour retained in source metadata',
    },
    {
      kind: 'limitation',
      feature: 'asset-type:livephoto',
      message: 'motion not available',
    },
    {
      kind: 'limitation',
      feature: 'unknown-card:reflection',
      message: 'unknown card retained as provenance',
    },
    { kind: 'unsupported_decode', message: 'platform cannot decode this still' },
    { kind: 'exceeds_video_upload_limit', message: 'imported locally; upload size limited' },
    { kind: 'sources_unreadable', message: 'no original entry time or timezone' },
  ],
}

/** Synthetic Apple Journal result. Counts only — no private export text. */
export const APPLE_JOURNAL_IMPORT_SUMMARY: ImportSummary = {
  imported: 4,
  skippedDuplicates: 1,
  errors: [],
  warnings: APPLE_JOURNAL_IMPORT_PREVIEW.warnings,
  apple: {
    entriesImported: 4,
    entriesFailed: 0,
    resourcesReferenced: 6,
    resourcesImported: 5,
    resourcesMissing: 1,
    resourcesUnsupported: 0,
    resourcesUnreferenced: 0,
    entriesSkippedExact: 1,
    entriesSourceChanged: 0,
  },
}

export const appleJournalImportInvoke: NonNullable<Scenario['invoke']> = {
  preview_apple_journal_import: async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 150)
    })
    return APPLE_JOURNAL_IMPORT_PREVIEW
  },
  import_data: async (args: Record<string, unknown>) => {
    await new Promise((resolve) => {
      setTimeout(resolve, 150)
    })
    if (args.format === 'apple_journal_folder') {
      return APPLE_JOURNAL_IMPORT_SUMMARY
    }
    return { imported: 0, skippedDuplicates: 0, errors: [] }
  },
  write_apple_journal_import_report: null,
}

export function createAppleJournalImportScenario(
  loggedInInvoke: NonNullable<Scenario['invoke']>,
): Scenario {
  return {
    id: 'apple-journal-import',
    label: 'Settings: Apple Journal import',
    group: 'settings',
    componentFile: 'ImportModal.tsx',
    invoke: {
      ...loggedInInvoke,
      ...appleJournalImportInvoke,
    },
    seedStores: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        settingsCategory: 'data',
        dataTab: 'import',
      })
    },
  }
}
