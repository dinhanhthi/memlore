import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useOnThisDay } from './useOnThisDay'
import type { DatePoint } from './useOnThisDay'
import type { Entry } from '../types/entry'

vi.mock('../lib/tauri', () => ({
  listOnThisDay: vi.fn(),
}))

import * as tauri from '../lib/tauri'

const makeEntry = (overrides: Partial<Entry> = {}): Entry => ({
  id: 'entry-1',
  journal_id: 'journal-1',
  title: 'Test Entry',
  preview_text: null,
  content_text: null,
  entry_date: 1_686_830_400,
  created_at: 1_686_830_400,
  updated_at: 1_686_830_400,
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
  media_count: 0,
  from_chat: false,
  content_language: null,
  entry_date_user_edited: false,
  ...overrides,
})

beforeEach(() => {
  vi.resetAllMocks()
})

describe('useOnThisDay', () => {
  it('calls listOnThisDay for each date in the input array', async () => {
    vi.mocked(tauri.listOnThisDay).mockResolvedValue([])
    const dates: DatePoint[] = [
      { month: 6, day: 15 },
      { month: 6, day: 14 },
      { month: 6, day: 13 },
    ]
    const { result } = renderHook(() => useOnThisDay(dates))
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
    expect(tauri.listOnThisDay).toHaveBeenCalledWith(6, 15, 'revealed', null)
    expect(tauri.listOnThisDay).toHaveBeenCalledWith(6, 14, 'revealed', null)
    expect(tauri.listOnThisDay).toHaveBeenCalledWith(6, 13, 'revealed', null)
    expect(tauri.listOnThisDay).toHaveBeenCalledTimes(3)
  })

  it('returns groups in input order with corresponding entries', async () => {
    const entryA = makeEntry({ id: 'a', entry_date: 1_686_830_400 })
    const entryB = makeEntry({ id: 'b', entry_date: 1_686_744_000 })
    vi.mocked(tauri.listOnThisDay)
      .mockResolvedValueOnce([entryA]) // month:6 day:15
      .mockResolvedValueOnce([entryB]) // month:6 day:14
      .mockResolvedValueOnce([]) // month:6 day:13

    const dates: DatePoint[] = [
      { month: 6, day: 15 },
      { month: 6, day: 14 },
      { month: 6, day: 13 },
    ]
    const { result } = renderHook(() => useOnThisDay(dates))
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.groups).toHaveLength(3)
    expect(result.current.groups[0].date).toEqual({ month: 6, day: 15 })
    expect(result.current.groups[0].entries).toEqual([entryA])
    expect(result.current.groups[1].date).toEqual({ month: 6, day: 14 })
    expect(result.current.groups[1].entries).toEqual([entryB])
    expect(result.current.groups[2].date).toEqual({ month: 6, day: 13 })
    expect(result.current.groups[2].entries).toEqual([])
  })

  it('filters entries by journalId when a journal scope is provided', async () => {
    const kept = makeEntry({ id: 'keep', journal_id: 'journal-1' })
    const removed = makeEntry({ id: 'drop', journal_id: 'journal-2' })
    vi.mocked(tauri.listOnThisDay).mockResolvedValue([kept, removed])

    const dates: DatePoint[] = [{ month: 6, day: 15 }]
    const { result } = renderHook(() => useOnThisDay(dates, 'journal-1'))

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.groups[0].entries).toEqual([kept])
  })

  it('re-filters existing results when journalId changes at runtime', async () => {
    const kept = makeEntry({ id: 'keep', journal_id: 'journal-1' })
    const removed = makeEntry({ id: 'drop', journal_id: 'journal-2' })
    vi.mocked(tauri.listOnThisDay).mockResolvedValue([kept, removed])

    const dates: DatePoint[] = [{ month: 6, day: 15 }]
    const { result, rerender } = renderHook(
      ({ journalId }: { journalId: string | null }) => useOnThisDay(dates, journalId),
      { initialProps: { journalId: 'journal-1' as string | null } },
    )

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
    expect(result.current.groups[0].entries).toEqual([kept])

    rerender({ journalId: null })

    await waitFor(() => {
      expect(result.current.groups[0].entries).toEqual([kept, removed])
    })
  })

  it('sets isEmpty=false when at least one group has entries', async () => {
    vi.mocked(tauri.listOnThisDay)
      .mockResolvedValueOnce([makeEntry({ id: 'a' })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])

    const dates: DatePoint[] = [
      { month: 6, day: 15 },
      { month: 6, day: 14 },
      { month: 6, day: 13 },
    ]
    const { result } = renderHook(() => useOnThisDay(dates))
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
    expect(result.current.isEmpty).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('sets isEmpty=true when all groups have zero entries', async () => {
    vi.mocked(tauri.listOnThisDay).mockResolvedValue([])

    const dates: DatePoint[] = [
      { month: 6, day: 15 },
      { month: 6, day: 14 },
      { month: 6, day: 13 },
    ]
    const { result } = renderHook(() => useOnThisDay(dates))
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
    expect(result.current.isEmpty).toBe(true)
  })

  it('captures error and sets groups=[] when any fetch rejects', async () => {
    vi.mocked(tauri.listOnThisDay).mockRejectedValue(new Error('locked'))

    const dates: DatePoint[] = [
      { month: 6, day: 15 },
      { month: 6, day: 14 },
      { month: 6, day: 13 },
    ]
    const { result } = renderHook(() => useOnThisDay(dates))
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
    expect(result.current.error).toBe('locked')
    expect(result.current.groups).toEqual([])
    expect(result.current.isEmpty).toBe(true)
  })

  it('does not refetch when re-rendered with same date values in a new array', async () => {
    vi.mocked(tauri.listOnThisDay).mockResolvedValue([])

    const dates1: DatePoint[] = [
      { month: 6, day: 15 },
      { month: 6, day: 14 },
      { month: 6, day: 13 },
    ]
    const { result, rerender } = renderHook(
      ({ dates }: { dates: DatePoint[] }) => useOnThisDay(dates),
      { initialProps: { dates: dates1 } },
    )
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
    expect(tauri.listOnThisDay).toHaveBeenCalledTimes(3)

    // Re-render with a new array object but identical values — should NOT refetch
    const dates2: DatePoint[] = [
      { month: 6, day: 15 },
      { month: 6, day: 14 },
      { month: 6, day: 13 },
    ]
    rerender({ dates: dates2 })
    expect(tauri.listOnThisDay).toHaveBeenCalledTimes(3)
  })

  it('starts in loading state before fetch resolves', () => {
    vi.mocked(tauri.listOnThisDay).mockReturnValue(new Promise(() => {}))

    const dates: DatePoint[] = [{ month: 6, day: 15 }]
    const { result } = renderHook(() => useOnThisDay(dates))
    expect(result.current.isLoading).toBe(true)
  })
})
