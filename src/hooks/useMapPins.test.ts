import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useMapPins } from './useMapPins'
import type { MapPin } from '../types/map'

vi.mock('../lib/tauri', () => ({
  listMapPins: vi.fn(),
}))

import * as tauri from '../lib/tauri'

const makePin = (overrides: Partial<MapPin> = {}): MapPin => ({
  id: 'entry:abc',
  kind: 'entry',
  entryId: 'abc',
  latitude: 10.1,
  longitude: 20.2,
  label: 'Home',
  entryDate: 1_700_000_000,
  thumbnailPath: null,
  ...overrides,
})

beforeEach(() => {
  vi.resetAllMocks()
})

describe('useMapPins', () => {
  it('invokes list_map_pins on mount', async () => {
    vi.mocked(tauri.listMapPins).mockResolvedValue([])
    const { result } = renderHook(() => useMapPins())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(tauri.listMapPins).toHaveBeenCalledTimes(1)
  })

  it('returns the pins array on success and flags non-empty', async () => {
    const pins = [makePin(), makePin({ id: 'photo:x', kind: 'photo', entryId: 'y', label: null })]
    vi.mocked(tauri.listMapPins).mockResolvedValue(pins)
    const { result } = renderHook(() => useMapPins())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.pins).toEqual(pins)
    expect(result.current.isEmpty).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('reports isEmpty=true when the backend returns no rows', async () => {
    vi.mocked(tauri.listMapPins).mockResolvedValue([])
    const { result } = renderHook(() => useMapPins())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.isEmpty).toBe(true)
    expect(result.current.pins).toEqual([])
    expect(result.current.error).toBeNull()
  })

  it('surfaces a string error message when the command rejects', async () => {
    vi.mocked(tauri.listMapPins).mockRejectedValue(new Error('locked'))
    const { result } = renderHook(() => useMapPins())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.error).toBe('locked')
    expect(result.current.pins).toEqual([])
    expect(result.current.isEmpty).toBe(true)
  })

  it('coerces non-Error rejections to a string', async () => {
    vi.mocked(tauri.listMapPins).mockRejectedValue('backend unavailable')
    const { result } = renderHook(() => useMapPins())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.error).toBe('backend unavailable')
  })
})
