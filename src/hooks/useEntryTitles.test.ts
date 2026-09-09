import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useEntryTitles } from './useEntryTitles'
import { useInvisibleLockStore } from '../stores/invisibleLockStore'
import type { Entry } from '../types/entry'

vi.mock('../lib/tauri', () => ({
  getEntry: vi.fn(),
}))

import * as tauri from '../lib/tauri'

const makeEntry = (overrides: Partial<Entry> = {}): Entry => ({
  id: 'e1',
  journal_id: 'j1',
  title: 'Morning walk',
  preview_text: 'p',
  content_text: 'c',
  entry_date: 1_700_000_000,
  created_at: 0,
  updated_at: 0,
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
  useInvisibleLockStore.setState({ activeVaultId: 'vault-a', autoLockMinutes: 5 })
})

describe('useEntryTitles', () => {
  it('returns an empty map and does not call backend for no ids', async () => {
    const { result } = renderHook(() => useEntryTitles([]))
    await new Promise((r) => setTimeout(r, 30))
    expect(result.current.titles.size).toBe(0)
    expect(result.current.loading).toBe(false)
    expect(tauri.getEntry).not.toHaveBeenCalled()
  })

  it('loads titles for each entry id', async () => {
    vi.mocked(tauri.getEntry).mockImplementation(async (id: string) => {
      if (id === 'e1') return makeEntry({ id: 'e1', title: 'First' })
      if (id === 'e2') return makeEntry({ id: 'e2', title: 'Second' })
      return null
    })

    const { result } = renderHook(() => useEntryTitles(['e1', 'e2']))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.titles.get('e1')).toBe('First')
    expect(result.current.titles.get('e2')).toBe('Second')
    expect(tauri.getEntry).toHaveBeenCalledTimes(2)
  })

  it('stores null for untitled entries', async () => {
    vi.mocked(tauri.getEntry).mockResolvedValue(makeEntry({ title: null }))

    const { result } = renderHook(() => useEntryTitles(['e1']))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.titles.get('e1')).toBeNull()
  })

  it('omits entries that are missing or fail to load', async () => {
    vi.mocked(tauri.getEntry).mockRejectedValue(new Error('boom'))

    const { result } = renderHook(() => useEntryTitles(['missing']))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.titles.has('missing')).toBe(false)
  })

  it('omits titles for locked entries', async () => {
    vi.mocked(tauri.getEntry).mockResolvedValue(
      makeEntry({ title: 'Private title', is_locked: true }),
    )

    const { result } = renderHook(() => useEntryTitles(['e1']))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.titles.has('e1')).toBe(false)
  })

  it('omits titles for deleted entries', async () => {
    vi.mocked(tauri.getEntry).mockResolvedValue(
      makeEntry({ title: 'Deleted title', is_deleted: true }),
    )

    const { result } = renderHook(() => useEntryTitles(['e1']))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.titles.has('e1')).toBe(false)
  })

  it('refetches titles when entries change after sync', async () => {
    vi.mocked(tauri.getEntry)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(makeEntry({ title: 'Arrived from sync' }))

    const { result } = renderHook(() => useEntryTitles(['e1']))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.titles.has('e1')).toBe(false)

    act(() => {
      window.dispatchEvent(new CustomEvent('memlore:entries-changed'))
    })

    await waitFor(() => expect(result.current.titles.get('e1')).toBe('Arrived from sync'))
    expect(tauri.getEntry).toHaveBeenCalledTimes(2)
  })

  it('keeps a newer refresh result when an older request finishes later', async () => {
    let resolveFirst: (entry: Entry | null) => void = () => undefined
    vi.mocked(tauri.getEntry)
      .mockImplementationOnce(
        () =>
          new Promise<Entry | null>((resolve) => {
            resolveFirst = resolve
          }),
      )
      .mockResolvedValue(makeEntry({ title: 'New title' }))

    const { result } = renderHook(() => useEntryTitles(['e1']))

    await waitFor(() => expect(tauri.getEntry).toHaveBeenCalledTimes(1))
    act(() => {
      window.dispatchEvent(new CustomEvent('memlore:entries-changed'))
    })
    await waitFor(() => expect(result.current.titles.get('e1')).toBe('New title'))

    await act(async () => {
      resolveFirst(makeEntry({ title: 'Old title' }))
      await Promise.resolve()
    })
    expect(result.current.loading).toBe(false)
    expect(result.current.titles.get('e1')).toBe('New title')
  })
})
