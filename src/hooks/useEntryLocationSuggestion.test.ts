import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useEntryLocationSuggestion } from './useEntryLocationSuggestion'
import type { ExifLocation } from '../lib/tauri'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

vi.mock('../lib/tauri', () => ({
  collectEntryExifLocations: vi.fn(),
}))

import * as tauri from '../lib/tauri'

const mockCollect = vi.mocked(tauri.collectEntryExifLocations)

const LOC_A: ExifLocation = { latitude: 48.8566, longitude: 2.3522 }
const LOC_B: ExifLocation = { latitude: 40.7128, longitude: -74.006 }

beforeEach(() => {
  vi.resetAllMocks()
})

describe('useEntryLocationSuggestion', () => {
  it('returns kind:none when entryId is null', async () => {
    const { result } = renderHook(() =>
      useEntryLocationSuggestion({ entryId: null, entryLocationUserEdited: false }),
    )

    await waitFor(() => {
      expect(result.current.suggestion.kind).toBe('none')
    })

    expect(mockCollect).not.toHaveBeenCalled()
  })

  it('returns kind:none when entryLocationUserEdited is true even if backend returns data', async () => {
    mockCollect.mockResolvedValue([LOC_A])

    const { result } = renderHook(() =>
      useEntryLocationSuggestion({ entryId: 'e-1', entryLocationUserEdited: true }),
    )

    await waitFor(() => {
      expect(result.current.suggestion.kind).toBe('none')
    })

    expect(mockCollect).not.toHaveBeenCalled()
  })

  it('returns kind:none when invoke resolves with empty array', async () => {
    mockCollect.mockResolvedValue([])

    const { result } = renderHook(() =>
      useEntryLocationSuggestion({ entryId: 'e-1', entryLocationUserEdited: false }),
    )

    await waitFor(() => {
      expect(result.current.suggestion.kind).toBe('none')
    })

    expect(mockCollect).toHaveBeenCalledWith('e-1')
  })

  it('returns kind:single when invoke resolves with one location', async () => {
    mockCollect.mockResolvedValue([LOC_A])

    const { result } = renderHook(() =>
      useEntryLocationSuggestion({ entryId: 'e-1', entryLocationUserEdited: false }),
    )

    await waitFor(() => {
      expect(result.current.suggestion.kind).toBe('single')
    })

    if (result.current.suggestion.kind === 'single') {
      expect(result.current.suggestion.location).toEqual(LOC_A)
    }
  })

  it('returns kind:multi when invoke resolves with two or more locations', async () => {
    mockCollect.mockResolvedValue([LOC_A, LOC_B])

    const { result } = renderHook(() =>
      useEntryLocationSuggestion({ entryId: 'e-1', entryLocationUserEdited: false }),
    )

    await waitFor(() => {
      expect(result.current.suggestion.kind).toBe('multi')
    })

    if (result.current.suggestion.kind === 'multi') {
      expect(result.current.suggestion.locations).toEqual([LOC_A, LOC_B])
    }
  })

  it('triggerCheck re-runs the fetch and the second response wins', async () => {
    mockCollect.mockResolvedValueOnce([LOC_A])

    const { result } = renderHook(() =>
      useEntryLocationSuggestion({ entryId: 'e-1', entryLocationUserEdited: false }),
    )

    await waitFor(() => {
      expect(result.current.suggestion.kind).toBe('single')
    })

    // Second call — two locations
    mockCollect.mockResolvedValueOnce([LOC_A, LOC_B])

    await act(async () => {
      await result.current.triggerCheck()
    })

    expect(result.current.suggestion.kind).toBe('multi')
    if (result.current.suggestion.kind === 'multi') {
      expect(result.current.suggestion.locations).toEqual([LOC_A, LOC_B])
    }
  })
})
