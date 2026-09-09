/**
 * Tests for `useAppleJournalImport`.
 *
 * Mocking follows the project rule: never call the real Tauri backend.
 * `@tauri-apps/api/event` `listen` and the `../lib/tauri` IPC wrappers
 * are mocked; we drive them via the `handlers` / wrapper spies.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppleJournalImportPreview, ImportSummary } from '../lib/tauri'

type Handler = (event: { payload: unknown }) => void
const handlers: Record<string, Handler> = {}
const unlistenSpies: Record<string, ReturnType<typeof vi.fn>> = {}

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: Handler) => {
    handlers[name] = handler
    const unlisten = vi.fn(() => {
      delete handlers[name]
    })
    unlistenSpies[name] = unlisten
    return unlisten
  }),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

vi.mock('../lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('../lib/tauri')>('../lib/tauri')
  return {
    ...actual,
    previewAppleJournalImport: vi.fn(),
    importData: vi.fn(),
    writeAppleJournalImportReport: vi.fn(),
  }
})

import * as tauri from '../lib/tauri'
import {
  buildAppleFidelityTotals,
  classifyAppleImportWarnings,
  formatAppleImportReport,
  isReportPathInsideSource,
  useAppleJournalImport,
} from './useAppleJournalImport'

const PROGRESS_EVENT = 'import:progress'

const previewFixture = (
  overrides: Partial<AppleJournalImportPreview> = {},
): AppleJournalImportPreview => ({
  sourceHash: 'hash-abc',
  conversionTimezone: 'Europe/Berlin',
  datePolicy: 'html_visible',
  datePrecision: 'date_only',
  clockIsSynthetic: true,
  entries: 3,
  resourcesReferenced: 5,
  resourcesWouldImport: 4,
  resourcesMissing: 1,
  resourcesUnsupported: 0,
  resourcesUnreferenced: 0,
  warnings: [{ kind: 'no_thumbnail', message: 'kept original' }],
  ...overrides,
})

const summaryFixture = (overrides: Partial<ImportSummary> = {}): ImportSummary => ({
  imported: 3,
  skippedDuplicates: 0,
  errors: [],
  ...overrides,
})

const completeSummary = (): ImportSummary =>
  summaryFixture({
    imported: 4,
    skippedDuplicates: 1,
    errors: [],
    warnings: [
      {
        kind: 'preserved_only',
        feature: 'font-color',
        message: 'PRIVATE: Dear diary secret colour #c41e3a',
      },
      {
        kind: 'preserved_only',
        feature: 'font-color',
        message: 'PRIVATE: entry title Sunset at home',
      },
      {
        kind: 'limitation',
        feature: 'asset-type:livephoto',
        message: 'livephoto still imported; motion not available',
      },
      {
        kind: 'limitation',
        feature: 'unknown-card:reflection',
        message: 'unknown card retained as provenance',
      },
      { kind: 'unsupported_decode', message: 'PRIVATE: /Users/me/export/Resources/secret.heic' },
      { kind: 'exceeds_video_upload_limit', message: 'imported locally; upload size limited' },
      { kind: 'sources_unreadable', message: 'no original entry time or timezone' },
    ],
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
  })

const failureSummary = (): ImportSummary =>
  summaryFixture({
    imported: 1,
    skippedDuplicates: 0,
    errors: ['entry failed: resource missing'],
    warnings: [{ kind: 'missing_resource', message: 'PRIVATE: missing clip.mov' }],
    apple: {
      entriesImported: 1,
      entriesFailed: 2,
      resourcesReferenced: 3,
      resourcesImported: 1,
      resourcesMissing: 2,
      resourcesUnsupported: 0,
      resourcesUnreferenced: 0,
      entriesSkippedExact: 0,
      entriesSourceChanged: 0,
    },
  })

const fireProgress = (payload: { percent: number; phase: string }) => {
  handlers[PROGRESS_EVENT]?.({ payload })
}

beforeEach(() => {
  vi.resetAllMocks()
  for (const k of Object.keys(handlers)) delete handlers[k]
  for (const k of Object.keys(unlistenSpies)) delete unlistenSpies[k]
  vi.mocked(tauri.previewAppleJournalImport).mockResolvedValue(previewFixture())
  vi.mocked(tauri.importData).mockResolvedValue(summaryFixture())
})

describe('useAppleJournalImport', () => {
  it('invalidates a completed preview when the source folder changes', async () => {
    const { result } = renderHook(() => useAppleJournalImport())

    act(() => {
      result.current.setSource('/export-a')
    })
    await act(async () => {
      await result.current.runPreview()
    })
    expect(result.current.preview?.sourceHash).toBe('hash-abc')
    expect(result.current.canImport).toBe(true)

    act(() => {
      result.current.setSource('/export-b')
    })

    expect(result.current.preview).toBeNull()
    expect(result.current.canImport).toBe(false)
  })

  it('ignores a stale preview reply after a newer request starts', async () => {
    let resolveFirst: ((value: AppleJournalImportPreview) => void) | undefined
    vi.mocked(tauri.previewAppleJournalImport)
      .mockImplementationOnce(
        () =>
          new Promise<AppleJournalImportPreview>((resolve) => {
            resolveFirst = resolve
          }),
      )
      .mockResolvedValueOnce(previewFixture({ sourceHash: 'hash-newer', entries: 9 }))

    const { result } = renderHook(() => useAppleJournalImport())
    act(() => {
      result.current.setSource('/export-a')
    })

    let firstPreview: Promise<void> | undefined
    act(() => {
      firstPreview = result.current.runPreview()
    })
    await act(async () => {
      await result.current.runPreview()
    })

    await act(async () => {
      resolveFirst?.(previewFixture({ sourceHash: 'hash-stale', entries: 1 }))
      await firstPreview
    })

    expect(result.current.preview?.sourceHash).toBe('hash-newer')
    expect(result.current.preview?.entries).toBe(9)
  })

  it('marks previewing immediately while the backend preview is in flight', async () => {
    let resolvePreview: ((value: AppleJournalImportPreview) => void) | undefined
    vi.mocked(tauri.previewAppleJournalImport).mockImplementation(
      () =>
        new Promise<AppleJournalImportPreview>((resolve) => {
          resolvePreview = resolve
        }),
    )

    const { result } = renderHook(() => useAppleJournalImport())
    act(() => {
      result.current.setSource('/export-a')
    })

    act(() => {
      void result.current.runPreview()
    })

    expect(result.current.previewing).toBe(true)
    expect(tauri.previewAppleJournalImport).toHaveBeenCalledOnce()
    resolvePreview?.(previewFixture())
  })

  it('marks importing immediately while the backend import is in flight', async () => {
    let resolveImport: ((value: ImportSummary) => void) | undefined
    vi.mocked(tauri.importData).mockImplementation(
      () =>
        new Promise<ImportSummary>((resolve) => {
          resolveImport = resolve
        }),
    )

    const { result } = renderHook(() => useAppleJournalImport())
    act(() => {
      result.current.setSource('/export-a')
      result.current.setJournalId('journal-1')
    })
    await act(async () => {
      await result.current.runPreview()
    })

    act(() => {
      void result.current.runImport()
    })

    expect(result.current.importing).toBe(true)
    expect(tauri.importData).toHaveBeenCalledOnce()
    resolveImport?.(summaryFixture())
  })

  it('does not import before a valid preview exists', async () => {
    const { result } = renderHook(() => useAppleJournalImport())
    act(() => {
      result.current.setSource('/export-a')
      result.current.setJournalId('journal-1')
    })

    await act(async () => {
      await result.current.runImport()
    })

    expect(tauri.importData).not.toHaveBeenCalled()
    expect(result.current.canImport).toBe(false)
  })

  it('subscribes to import progress while previewing and unlistens on unmount', async () => {
    let resolvePreview: ((value: AppleJournalImportPreview) => void) | undefined
    vi.mocked(tauri.previewAppleJournalImport).mockImplementation(
      () =>
        new Promise<AppleJournalImportPreview>((resolve) => {
          resolvePreview = resolve
        }),
    )

    const { result, unmount } = renderHook(() => useAppleJournalImport())
    act(() => {
      result.current.setSource('/export-a')
    })
    act(() => {
      void result.current.runPreview()
    })

    await waitFor(() => expect(handlers[PROGRESS_EVENT]).toBeDefined())

    act(() => {
      fireProgress({ percent: 40, phase: 'reading' })
    })
    expect(result.current.progress).toBe(40)
    expect(result.current.progressPhase).toBe('reading')

    unmount()
    expect(unlistenSpies[PROGRESS_EVENT]).toHaveBeenCalledOnce()

    resolvePreview?.(previewFixture())
  })

  it('surfaces backend preview and import errors', async () => {
    vi.mocked(tauri.previewAppleJournalImport).mockRejectedValueOnce(
      new Error('Apple Journal preflight: missing Entries'),
    )

    const { result } = renderHook(() => useAppleJournalImport())
    act(() => {
      result.current.setSource('/export-a')
      result.current.setJournalId('journal-1')
    })

    await act(async () => {
      await result.current.runPreview()
    })
    expect(result.current.error).toBe('Apple Journal preflight: missing Entries')
    expect(result.current.preview).toBeNull()
    expect(result.current.canImport).toBe(false)

    vi.mocked(tauri.previewAppleJournalImport).mockResolvedValueOnce(previewFixture())
    await act(async () => {
      await result.current.runPreview()
    })
    expect(result.current.error).toBeNull()

    vi.mocked(tauri.importData).mockRejectedValueOnce(new Error('source changed'))
    await act(async () => {
      await result.current.runImport()
    })
    expect(result.current.error).toBe('source changed')
    expect(result.current.preview).toBeNull()
  })

  it('binds import to the selected source, journal, timezone and preview hash', async () => {
    const { result } = renderHook(() => useAppleJournalImport())
    act(() => {
      result.current.setSource('/export-a')
      result.current.setJournalId('journal-1')
      result.current.setConversionTimezone('Asia/Ho_Chi_Minh')
    })
    await act(async () => {
      await result.current.runPreview()
    })

    expect(tauri.previewAppleJournalImport).toHaveBeenCalledWith('/export-a', {
      conversionTimezone: 'Asia/Ho_Chi_Minh',
    })

    await act(async () => {
      await result.current.runImport()
    })

    expect(tauri.importData).toHaveBeenCalledWith(
      '/export-a',
      'apple_journal_folder',
      'merge_newer',
      'journal-1',
      {
        conversionTimezone: 'Asia/Ho_Chi_Minh',
        expectedSourceHash: 'hash-abc',
      },
    )
    expect(result.current.summary?.imported).toBe(3)
  })

  it('exposes converted, preserved-only, skipped-duplicate and failed totals after a complete import', async () => {
    vi.mocked(tauri.importData).mockResolvedValueOnce(completeSummary())
    const { result } = renderHook(() => useAppleJournalImport())
    act(() => {
      result.current.setSource('/export-a')
      result.current.setJournalId('journal-1')
    })
    await act(async () => {
      await result.current.runPreview()
    })
    await act(async () => {
      await result.current.runImport()
    })

    expect(result.current.fidelity).toEqual({
      entries: { converted: 2, preservedOnly: 2, skippedExactDuplicates: 1, failed: 0 },
      media: { converted: 5, preservedOnly: 1, skippedExactDuplicates: 0, failed: 1 },
      metadata: { converted: 0, preservedOnly: 4, skippedExactDuplicates: 0, failed: 1 },
    })
  })

  it('classifies warnings without copying private source text into the report', () => {
    const classified = classifyAppleImportWarnings(completeSummary().warnings ?? [])
    expect(classified).toEqual([
      { kind: 'unsupported_visual_styling', count: 2 },
      { kind: 'missing_live_photo_motion', count: 1 },
      { kind: 'unknown_metadata_or_cards', count: 1 },
      { kind: 'unsupported_platform_decoding', count: 1 },
      { kind: 'media_upload_constraint', count: 1 },
      { kind: 'missing_source_time_zone', count: 1 },
    ])

    const text = formatAppleImportReport({
      totals: buildAppleFidelityTotals(completeSummary(), previewFixture()),
      warnings: classified,
      conversionTimezone: 'Europe/Berlin',
      clockIsSynthetic: true,
    })
    expect(text).toContain('Preserved-only is not fully converted')
    expect(text).toContain('Native metadata')
    expect(text).toContain('Retained as provenance')
    expect(text).toContain('synthetic local noon')
    expect(text).not.toMatch(/fully converted formatting/)
    expect(text).not.toContain('Dear diary')
    expect(text).not.toContain('Sunset at home')
    expect(text).not.toContain('secret.heic')
    expect(text).not.toContain('#c41e3a')
  })

  it('counts failed entries and media from a failure result', () => {
    const totals = buildAppleFidelityTotals(failureSummary(), previewFixture())
    expect(totals.entries.failed).toBe(2)
    expect(totals.entries.converted).toBe(1)
    expect(totals.media.failed).toBe(2)
    expect(totals.media.converted).toBe(1)
  })

  it('saves the report only to an explicit user-selected path outside the source folder', async () => {
    vi.mocked(tauri.importData).mockResolvedValueOnce(completeSummary())
    vi.mocked(tauri.writeAppleJournalImportReport).mockResolvedValueOnce(undefined)

    const { result } = renderHook(() => useAppleJournalImport())
    act(() => {
      result.current.setSource('/export-a')
      result.current.setJournalId('journal-1')
    })
    await act(async () => {
      await result.current.runPreview()
    })
    await act(async () => {
      await result.current.runImport()
    })

    await act(async () => {
      await result.current.saveReport('', 'report body')
    })
    expect(tauri.writeAppleJournalImportReport).not.toHaveBeenCalled()
    expect(result.current.reportSaveStatus).toEqual({ kind: 'cancelled' })

    await act(async () => {
      await result.current.saveReport('/export-a/nested-report.txt', 'report body')
    })
    expect(tauri.writeAppleJournalImportReport).not.toHaveBeenCalled()
    expect(result.current.reportSaveStatus.kind).toBe('error')

    await act(async () => {
      await result.current.saveReport(
        '/tmp/memlore-apple-journal-import-report.txt',
        'report body',
      )
    })
    expect(tauri.writeAppleJournalImportReport).toHaveBeenCalledWith(
      '/tmp/memlore-apple-journal-import-report.txt',
      'report body',
      '/export-a',
    )
    expect(result.current.reportSaveStatus).toEqual({
      kind: 'saved',
      path: '/tmp/memlore-apple-journal-import-report.txt',
    })
    expect(result.current.source).toBe('/export-a')
  })

  it('treats a report path inside the source folder as forbidden', () => {
    expect(isReportPathInsideSource('/export-a/report.txt', '/export-a')).toBe(true)
    expect(isReportPathInsideSource('/export-a', '/export-a')).toBe(true)
    expect(isReportPathInsideSource('/tmp/report.txt', '/export-a')).toBe(false)
  })

  it('invalidates a completed preview when the conversion timezone changes', async () => {
    const { result } = renderHook(() => useAppleJournalImport())
    act(() => {
      result.current.setSource('/export-a')
    })
    await act(async () => {
      await result.current.runPreview()
    })
    expect(result.current.preview).not.toBeNull()
    expect(result.current.canImport).toBe(true)

    act(() => {
      result.current.setConversionTimezone('Asia/Tokyo')
    })

    expect(result.current.preview).toBeNull()
    expect(result.current.canImport).toBe(false)
  })

  it('refuses import while a preview request is in flight', async () => {
    let resolveSecond: ((value: AppleJournalImportPreview) => void) | undefined
    vi.mocked(tauri.previewAppleJournalImport)
      .mockResolvedValueOnce(previewFixture())
      .mockImplementationOnce(
        () =>
          new Promise<AppleJournalImportPreview>((resolve) => {
            resolveSecond = resolve
          }),
      )

    const { result } = renderHook(() => useAppleJournalImport())
    act(() => {
      result.current.setSource('/export-a')
      result.current.setJournalId('journal-1')
    })
    await act(async () => {
      await result.current.runPreview()
    })
    expect(result.current.canImport).toBe(true)

    act(() => {
      void result.current.runPreview()
    })
    await waitFor(() => expect(result.current.previewing).toBe(true))

    await act(async () => {
      await result.current.runImport()
    })

    expect(tauri.importData).not.toHaveBeenCalled()
    resolveSecond?.(previewFixture({ sourceHash: 'hash-second' }))
  })

  it('surfaces a report-save write rejection', async () => {
    vi.mocked(tauri.importData).mockResolvedValueOnce(completeSummary())
    vi.mocked(tauri.writeAppleJournalImportReport).mockRejectedValueOnce(new Error('disk full'))

    const { result } = renderHook(() => useAppleJournalImport())
    act(() => {
      result.current.setSource('/export-a')
      result.current.setJournalId('journal-1')
    })
    await act(async () => {
      await result.current.runPreview()
    })
    await act(async () => {
      await result.current.runImport()
    })

    await act(async () => {
      await result.current.saveReport(
        '/tmp/memlore-apple-journal-import-report.txt',
        'report body',
      )
    })

    expect(tauri.writeAppleJournalImportReport).toHaveBeenCalled()
    expect(result.current.reportSaveStatus).toEqual({ kind: 'error', message: 'disk full' })
  })

  it('does not count preserved-only entries as fully converted', () => {
    const totals = buildAppleFidelityTotals(completeSummary(), previewFixture())
    const imported = completeSummary().apple?.entriesImported ?? 0
    expect(totals.entries.converted + totals.entries.preservedOnly).toBe(imported)
    expect(totals.entries.converted).toBeLessThan(imported)
    expect(totals.entries.preservedOnly).toBeGreaterThan(0)
  })

  it('does not invent a hardcoded metadata converted count of 3', () => {
    const totals = buildAppleFidelityTotals(completeSummary(), previewFixture())
    expect(totals.metadata.converted).not.toBe(3)
  })

  it('classifies Live Photo from structured feature, not English prose', () => {
    const classified = classifyAppleImportWarnings([
      {
        kind: 'limitation',
        feature: 'asset-type:livephoto',
        message: 'ảnh động không có sẵn trong trình soạn thảo',
      },
    ])
    expect(classified).toEqual([{ kind: 'missing_live_photo_motion', count: 1 }])
  })
})
