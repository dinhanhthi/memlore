import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

vi.mock('../lib/tauri', () => ({
  generatePeriodReview: vi.fn(),
  getPeriodReview: vi.fn(),
  listEntriesForDateRange: vi.fn(),
}))

import * as tauri from '../lib/tauri'
import { usePeriodReview } from './usePeriodReview'
import { localMidnight, periodRange } from '../lib/periodReview'

const ANCHOR = localMidnight(2024, 6, 15)

const SAMPLE_RESULT = {
  kind: 'weekly' as const,
  start: 1,
  end: 2,
  entryCount: 2,
  highlights: ['Good'],
  lowlights: ['Stress'],
  themes: ['Work'],
  insight: 'Keep going.',
  cached: false,
  modelId: 'mock:v1',
  createdAt: 1_700_000_000,
}

beforeEach(() => {
  vi.mocked(tauri.generatePeriodReview).mockReset()
  vi.mocked(tauri.getPeriodReview).mockReset()
  vi.mocked(tauri.listEntriesForDateRange).mockReset()
  vi.mocked(tauri.getPeriodReview).mockResolvedValue(null)
})

describe('usePeriodReview', () => {
  it('generates immediately for local endpoints', async () => {
    vi.mocked(tauri.generatePeriodReview).mockResolvedValueOnce(SAMPLE_RESULT)
    const { result } = renderHook(() =>
      usePeriodReview({
        kind: 'weekly',
        anchorSec: ANCHOR,
        needsBulkConsent: () => false,
        generationEndpointClass: 'local',
      }),
    )

    await act(async () => {
      await result.current.generate(false)
    })

    await waitFor(() => expect(result.current.phase.kind).toBe('ready'))
    expect(tauri.generatePeriodReview).toHaveBeenCalled()
    expect(tauri.listEntriesForDateRange).not.toHaveBeenCalled()
  })

  it('pauses for bulk consent on remote when receipt missing', async () => {
    vi.mocked(tauri.listEntriesForDateRange).mockResolvedValueOnce([
      {
        id: 'e1',
        journal_id: 'j1',
        title: 'T',
        content_text: 'Body',
        entry_date: ANCHOR,
        created_at: 0,
        updated_at: 0,
        preview_text: null,
        latitude: null,
        longitude: null,
        location_label: null,
        location_address: null,
        weather_summary: null,
        weather_icon: null,
        emotion: null,
        is_favorite: false,
        is_deleted: false,
        is_locked: false,
        is_invisible: false,
        vault_id: null,
        cover_media_id: null,
        content_language: null,
        entry_date_user_edited: false,
        media_count: 0,
        from_chat: false,
      },
    ])

    const { result } = renderHook(() =>
      usePeriodReview({
        kind: 'weekly',
        anchorSec: ANCHOR,
        needsBulkConsent: () => true,
        generationEndpointClass: 'remote',
      }),
    )

    await act(async () => {
      await result.current.generate(false)
    })

    expect(result.current.phase.kind).toBe('needs_bulk_consent')
    if (result.current.phase.kind === 'needs_bulk_consent') {
      expect(result.current.phase.entryCount).toBe(1)
    }
    expect(tauri.generatePeriodReview).not.toHaveBeenCalled()
  })

  it('confirmBulkConsent runs generation after modal accept', async () => {
    vi.mocked(tauri.listEntriesForDateRange).mockResolvedValueOnce([
      {
        id: 'e1',
        journal_id: 'j1',
        title: 'T',
        content_text: 'Body',
        entry_date: ANCHOR,
        created_at: 0,
        updated_at: 0,
        preview_text: null,
        latitude: null,
        longitude: null,
        location_label: null,
        location_address: null,
        weather_summary: null,
        weather_icon: null,
        emotion: null,
        is_favorite: false,
        is_deleted: false,
        is_locked: false,
        is_invisible: false,
        vault_id: null,
        cover_media_id: null,
        content_language: null,
        entry_date_user_edited: false,
        media_count: 0,
        from_chat: false,
      },
    ])
    vi.mocked(tauri.generatePeriodReview).mockResolvedValueOnce(SAMPLE_RESULT)

    const { result } = renderHook(() =>
      usePeriodReview({
        kind: 'weekly',
        anchorSec: ANCHOR,
        needsBulkConsent: () => true,
        generationEndpointClass: 'remote',
      }),
    )

    await act(async () => {
      await result.current.generate(false)
    })
    await act(async () => {
      await result.current.confirmBulkConsent()
    })

    await waitFor(() => expect(result.current.phase.kind).toBe('ready'))
    expect(tauri.generatePeriodReview).toHaveBeenCalledTimes(1)
  })

  it('loads stored result on mount without generating', async () => {
    vi.mocked(tauri.getPeriodReview).mockResolvedValue(SAMPLE_RESULT)

    const { result } = renderHook(() =>
      usePeriodReview({
        kind: 'weekly',
        anchorSec: ANCHOR,
        needsBulkConsent: () => false,
        generationEndpointClass: 'local',
      }),
    )

    await waitFor(() => expect(result.current.phase.kind).toBe('ready'))
    if (result.current.phase.kind === 'ready') {
      expect(result.current.phase.result).toEqual(SAMPLE_RESULT)
    }
    const bounds = periodRange('weekly', ANCHOR)
    expect(tauri.getPeriodReview).toHaveBeenCalledWith(bounds.start, bounds.end, 'weekly')
    expect(tauri.generatePeriodReview).not.toHaveBeenCalled()
  })

  it('fetches the new period when anchorSec changes without generating', async () => {
    const nextAnchor = localMidnight(2024, 7, 15)
    const firstBounds = periodRange('weekly', ANCHOR)
    const nextBounds = periodRange('weekly', nextAnchor)
    const nextResult = { ...SAMPLE_RESULT, start: nextBounds.start, insight: 'July week.' }

    vi.mocked(tauri.getPeriodReview).mockImplementation(async (start) => {
      if (start === nextBounds.start) return nextResult
      return SAMPLE_RESULT
    })

    const { result, rerender } = renderHook(
      ({ anchorSec }) =>
        usePeriodReview({
          kind: 'weekly',
          anchorSec,
          needsBulkConsent: () => false,
          generationEndpointClass: 'local',
        }),
      { initialProps: { anchorSec: ANCHOR } },
    )

    await waitFor(() => expect(result.current.phase.kind).toBe('ready'))
    expect(tauri.getPeriodReview).toHaveBeenCalledWith(firstBounds.start, firstBounds.end, 'weekly')

    rerender({ anchorSec: nextAnchor })

    await waitFor(() => {
      expect(tauri.getPeriodReview).toHaveBeenCalledWith(nextBounds.start, nextBounds.end, 'weekly')
    })
    await waitFor(() => {
      expect(result.current.phase.kind).toBe('ready')
      if (result.current.phase.kind === 'ready') {
        expect(result.current.phase.result.insight).toBe('July week.')
      }
    })
    expect(tauri.generatePeriodReview).not.toHaveBeenCalled()
  })

  it('stays idle when the store has no review for the period', async () => {
    vi.mocked(tauri.getPeriodReview).mockResolvedValue(null)

    const { result } = renderHook(() =>
      usePeriodReview({
        kind: 'weekly',
        anchorSec: ANCHOR,
        needsBulkConsent: () => false,
        generationEndpointClass: 'local',
      }),
    )

    await waitFor(() => expect(tauri.getPeriodReview).toHaveBeenCalled())
    expect(result.current.phase.kind).toBe('idle')
    expect(tauri.generatePeriodReview).not.toHaveBeenCalled()
  })

  it('restores the stored review when bulk-consent is cancelled', async () => {
    vi.mocked(tauri.getPeriodReview).mockResolvedValue(SAMPLE_RESULT)
    vi.mocked(tauri.listEntriesForDateRange).mockResolvedValueOnce([
      {
        id: 'e1',
        journal_id: 'j1',
        title: 'T',
        content_text: 'Body',
        entry_date: ANCHOR,
        created_at: 0,
        updated_at: 0,
        preview_text: null,
        latitude: null,
        longitude: null,
        location_label: null,
        location_address: null,
        weather_summary: null,
        weather_icon: null,
        emotion: null,
        is_favorite: false,
        is_deleted: false,
        is_locked: false,
        is_invisible: false,
        vault_id: null,
        cover_media_id: null,
        content_language: null,
        entry_date_user_edited: false,
        media_count: 0,
        from_chat: false,
      },
    ])

    const { result } = renderHook(() =>
      usePeriodReview({
        kind: 'weekly',
        anchorSec: ANCHOR,
        needsBulkConsent: () => true,
        generationEndpointClass: 'remote',
      }),
    )

    await waitFor(() => expect(result.current.phase.kind).toBe('ready'))
    if (result.current.phase.kind === 'ready') {
      expect(result.current.phase.result).toEqual(SAMPLE_RESULT)
    }

    await act(async () => {
      await result.current.generate(false)
    })

    expect(result.current.phase.kind).toBe('needs_bulk_consent')
    const fetchesAfterGenerate = vi.mocked(tauri.getPeriodReview).mock.calls.length

    await act(async () => {
      result.current.dismiss()
    })

    await waitFor(() => {
      expect(vi.mocked(tauri.getPeriodReview).mock.calls.length).toBeGreaterThan(
        fetchesAfterGenerate,
      )
      expect(result.current.phase.kind).toBe('ready')
    })
    if (result.current.phase.kind === 'ready') {
      expect(result.current.phase.result).toEqual(SAMPLE_RESULT)
    }
    expect(result.current.phase.kind).not.toBe('loading')
    expect(tauri.generatePeriodReview).not.toHaveBeenCalled()
    const bounds = periodRange('weekly', ANCHOR)
    expect(tauri.getPeriodReview).toHaveBeenCalledWith(bounds.start, bounds.end, 'weekly')
  })
})
