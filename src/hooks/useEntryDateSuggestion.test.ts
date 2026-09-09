import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useEntryDateSuggestion } from './useEntryDateSuggestion'

vi.mock('../lib/tauri', () => ({
  collectEntryExifDates: vi.fn(),
}))

import * as tauriLib from '../lib/tauri'

describe('useEntryDateSuggestion', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns kind=none when no EXIF dates exist', async () => {
    vi.mocked(tauriLib.collectEntryExifDates).mockResolvedValue([])
    const { result } = renderHook(() =>
      useEntryDateSuggestion({ entryId: 'e-1', entryDateUserEdited: false }),
    )
    await waitFor(() => {
      expect(result.current.suggestion.kind).toBe('none')
    })
  })

  it('returns kind=single when exactly one distinct EXIF date', async () => {
    const ts = 1_686_825_000
    vi.mocked(tauriLib.collectEntryExifDates).mockResolvedValue([ts])
    const { result } = renderHook(() =>
      useEntryDateSuggestion({ entryId: 'e-1', entryDateUserEdited: false }),
    )
    await waitFor(() => {
      expect(result.current.suggestion).toEqual({ kind: 'single', date: ts })
    })
  })

  it('returns kind=multi when multiple distinct EXIF dates', async () => {
    const ts1 = 1_686_825_000
    const ts2 = 1_686_825_000 + 86_400
    vi.mocked(tauriLib.collectEntryExifDates).mockResolvedValue([ts1, ts2])
    const { result } = renderHook(() =>
      useEntryDateSuggestion({ entryId: 'e-1', entryDateUserEdited: false }),
    )
    await waitFor(() => {
      expect(result.current.suggestion).toEqual({ kind: 'multi', dates: [ts1, ts2] })
    })
  })

  it('returns kind=none when entryDateUserEdited is true (suppress suggestion)', async () => {
    const ts = 1_686_825_000
    vi.mocked(tauriLib.collectEntryExifDates).mockResolvedValue([ts])
    const { result } = renderHook(() =>
      useEntryDateSuggestion({ entryId: 'e-1', entryDateUserEdited: true }),
    )
    // Even with EXIF dates, user-edited flag means no suggestion
    await waitFor(() => {
      expect(result.current.suggestion.kind).toBe('none')
    })
  })

  it('returns kind=none when entryId is null', async () => {
    vi.mocked(tauriLib.collectEntryExifDates).mockResolvedValue([1_686_825_000])
    const { result } = renderHook(() =>
      useEntryDateSuggestion({ entryId: null, entryDateUserEdited: false }),
    )
    await waitFor(() => {
      expect(result.current.suggestion.kind).toBe('none')
    })
    expect(vi.mocked(tauriLib.collectEntryExifDates)).not.toHaveBeenCalled()
  })

  it('exposes a trigger function that re-fetches dates', async () => {
    vi.mocked(tauriLib.collectEntryExifDates).mockResolvedValue([])
    const { result } = renderHook(() =>
      useEntryDateSuggestion({ entryId: 'e-1', entryDateUserEdited: false }),
    )
    await waitFor(() => {
      expect(result.current.suggestion.kind).toBe('none')
    })
    // Now mock a single EXIF date and re-trigger
    const ts = 1_700_000_000
    vi.mocked(tauriLib.collectEntryExifDates).mockResolvedValue([ts])
    result.current.triggerCheck()
    await waitFor(() => {
      expect(result.current.suggestion).toEqual({ kind: 'single', date: ts })
    })
  })
})
