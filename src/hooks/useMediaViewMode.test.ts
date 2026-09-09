import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

vi.mock('../lib/tauri', () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}))

import { getSetting, setSetting } from '../lib/tauri'
import {
  __resetMediaViewModeForTests,
  hydrateMediaViewMode,
  useMediaViewMode,
  useMediaViewModeHydrated,
  useMediaViewModeSetting,
} from './useMediaViewMode'

const mockedGet = vi.mocked(getSetting)
const mockedSet = vi.mocked(setSetting)

beforeEach(() => {
  mockedGet.mockReset()
  mockedSet.mockReset()
  mockedGet.mockResolvedValue(null)
  mockedSet.mockResolvedValue(undefined)
  __resetMediaViewModeForTests()
})

describe('useMediaViewMode', () => {
  it("defaults to 'full' with hydrated false before hydration", () => {
    const { result: mode } = renderHook(() => useMediaViewMode())
    const { result: hydrated } = renderHook(() => useMediaViewModeHydrated())

    expect(mode.current).toBe('full')
    expect(hydrated.current).toBe(false)
  })

  it("hydrates to 'panel' when getSetting returns 'panel'", async () => {
    mockedGet.mockResolvedValue('panel')

    await hydrateMediaViewMode()

    const { result: mode } = renderHook(() => useMediaViewMode())
    const { result: hydrated } = renderHook(() => useMediaViewModeHydrated())

    expect(mode.current).toBe('panel')
    expect(hydrated.current).toBe(true)
    expect(mockedGet).toHaveBeenCalledWith('media_view_mode')
  })

  it("falls back to 'full' when getSetting returns null or garbage", async () => {
    mockedGet.mockResolvedValueOnce(null)
    await hydrateMediaViewMode()
    expect(renderHook(() => useMediaViewMode()).result.current).toBe('full')
    expect(renderHook(() => useMediaViewModeHydrated()).result.current).toBe(true)

    __resetMediaViewModeForTests()
    mockedGet.mockResolvedValueOnce('garbage')
    await hydrateMediaViewMode()
    expect(renderHook(() => useMediaViewMode()).result.current).toBe('full')
    expect(renderHook(() => useMediaViewModeHydrated()).result.current).toBe(true)
  })

  it("falls back to 'full' and marks hydrated when getSetting rejects", async () => {
    mockedGet.mockRejectedValue(new Error('db locked'))

    await expect(hydrateMediaViewMode()).resolves.toBeUndefined()

    const { result: mode } = renderHook(() => useMediaViewMode())
    const { result: hydrated } = renderHook(() => useMediaViewModeHydrated())

    expect(mode.current).toBe('full')
    expect(hydrated.current).toBe(true)
  })

  it("setMediaViewMode('panel') persists and notifies subscribers", async () => {
    const { result } = renderHook(() => useMediaViewModeSetting())
    const { result: modeOnly } = renderHook(() => useMediaViewMode())

    expect(result.current.mediaViewMode).toBe('full')
    expect(modeOnly.current).toBe('full')

    await act(async () => {
      await result.current.setMediaViewMode('panel')
    })

    await waitFor(() => {
      expect(result.current.mediaViewMode).toBe('panel')
      expect(modeOnly.current).toBe('panel')
    })

    expect(mockedSet).toHaveBeenCalledWith('media_view_mode', 'panel')
    expect(result.current.hydrated).toBe(true)
  })
})
