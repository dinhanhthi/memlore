import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useEntryAttachments } from './useEntryAttachments'
import type { MediaRow } from '../lib/tauri'

vi.mock('../lib/tauri', () => ({
  listMediaForEntry: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

import * as tauri from '../lib/tauri'

const mockListMediaForEntry = vi.mocked(tauri.listMediaForEntry)

function makeMediaRow(overrides: Partial<MediaRow> = {}): MediaRow {
  return {
    id: 'm-1',
    entry_id: 'e-1',
    file_name: 'photo.png',
    file_type: 'image/png',
    storage_provider: 'local',
    storage_path: '/media/photo.png',
    thumbnail_path: null,
    upload_status: 'pending',
    uploaded_at: null,
    file_size: null,
    cloud_path: null,
    last_accessed_at: null,
    sort_order: 0,
    created_at: 1_700_000_000,
    exif_date: null,
    exif_latitude: null,
    exif_longitude: null,
    duration_seconds: null,
    insertion_mode: 'attached',
    ...overrides,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe('useEntryAttachments', () => {
  it('calls listMediaForEntry with entryId only (no mode filter) on mount', async () => {
    mockListMediaForEntry.mockResolvedValue([])

    const { result } = renderHook(() => useEntryAttachments('entry-1'))

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(mockListMediaForEntry).toHaveBeenCalledWith('entry-1', undefined, null)
  })

  it('returns all media rows (inline and attached)', async () => {
    const rows = [makeMediaRow({ id: 'm-1' }), makeMediaRow({ id: 'm-2' })]
    mockListMediaForEntry.mockResolvedValue(rows)

    const { result } = renderHook(() => useEntryAttachments('entry-1'))

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.attachments).toHaveLength(2)
    expect(result.current.attachments[0].id).toBe('m-1')
    expect(result.current.attachments[1].id).toBe('m-2')
  })

  it('refetch re-calls listMediaForEntry', async () => {
    mockListMediaForEntry.mockResolvedValue([makeMediaRow()])

    const { result } = renderHook(() => useEntryAttachments('entry-1'))

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(mockListMediaForEntry).toHaveBeenCalledTimes(1)

    await act(async () => {
      result.current.refetch()
    })

    await waitFor(() => {
      expect(mockListMediaForEntry).toHaveBeenCalledTimes(2)
    })
  })

  it('returns empty array when entryId is undefined and makes no Tauri call', async () => {
    const { result } = renderHook(() => useEntryAttachments(undefined))

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(mockListMediaForEntry).not.toHaveBeenCalled()
    expect(result.current.attachments).toEqual([])
  })

  it('returns empty array and clears loading when listMediaForEntry rejects', async () => {
    mockListMediaForEntry.mockRejectedValue(new Error('DB error'))
    const { result } = renderHook(() => useEntryAttachments('entry-1'))
    // Immediately after render the hook should be in a loading state.
    expect(result.current.isLoading).toBe(true)
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.attachments).toEqual([])
  })

  it('re-fetches when entryId changes', async () => {
    mockListMediaForEntry.mockResolvedValue([makeMediaRow()])

    const { result, rerender } = renderHook(
      ({ entryId }: { entryId: string | undefined }) => useEntryAttachments(entryId),
      { initialProps: { entryId: 'entry-1' as string | undefined } },
    )

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    rerender({ entryId: 'entry-2' })

    await waitFor(() => {
      expect(mockListMediaForEntry).toHaveBeenLastCalledWith('entry-2', undefined, null)
    })
  })
})
