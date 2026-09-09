import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { __resetSearchOverlayModeForTests, useSearchOverlayMode } from './useSearchOverlayMode'

beforeEach(() => {
  __resetSearchOverlayModeForTests()
})

describe('useSearchOverlayMode', () => {
  it('restores the last-set overlay mode after remount', () => {
    const first = renderHook(() => useSearchOverlayMode('keyword', false, true))
    expect(first.result.current.mode).toBe('keyword')
    expect(first.result.current.activeMode).toBe('keyword')

    act(() => {
      first.result.current.setMode('meaning')
    })
    expect(first.result.current.mode).toBe('meaning')
    expect(first.result.current.activeMode).toBe('meaning')

    first.unmount()

    // Simulates SearchOverlay returning null (unmounting content) then
    // remounting on the next open. Settings default is still keyword.
    const second = renderHook(() => useSearchOverlayMode('keyword', false, true))
    expect(second.result.current.mode).toBe('meaning')
    expect(second.result.current.activeMode).toBe('meaning')
  })

  it('seeds from the Settings default when no session override exists', () => {
    const { result } = renderHook(() => useSearchOverlayMode('meaning', false, true))
    expect(result.current.mode).toBe('meaning')
    expect(result.current.activeMode).toBe('meaning')
  })

  it('keeps a keyword session override when the Settings default is meaning', () => {
    const first = renderHook(() => useSearchOverlayMode('meaning', false, true))
    act(() => {
      first.result.current.setMode('keyword')
    })
    first.unmount()

    const second = renderHook(() => useSearchOverlayMode('meaning', false, true))
    expect(second.result.current.mode).toBe('keyword')
    expect(second.result.current.activeMode).toBe('keyword')
  })

  it('falls back to keyword when semantic search is disabled', () => {
    const { result } = renderHook(() => useSearchOverlayMode('meaning', false, false))
    expect(result.current.mode).toBe('keyword')
    expect(result.current.activeMode).toBe('keyword')

    act(() => {
      result.current.setMode('meaning')
    })
    expect(result.current.mode).toBe('meaning')
    expect(result.current.activeMode).toBe('keyword')
  })

  it('uses keyword while the Settings default is still loading', () => {
    const { result } = renderHook(() => useSearchOverlayMode('meaning', true, true))
    expect(result.current.mode).toBe('keyword')
    expect(result.current.activeMode).toBe('keyword')
  })
})
