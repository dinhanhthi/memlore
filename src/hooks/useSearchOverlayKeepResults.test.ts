import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  __resetSearchOverlayKeepResultsForTests,
  searchOverlayRetentionKey,
  shouldRetainSearchOverlayContent,
  useSearchOverlayKeepResults,
} from './useSearchOverlayKeepResults'

beforeEach(() => {
  __resetSearchOverlayKeepResultsForTests()
})

describe('useSearchOverlayKeepResults', () => {
  it('defaults to false before any toggle', () => {
    const { result } = renderHook(() => useSearchOverlayKeepResults())
    expect(result.current.keepResults).toBe(false)
  })

  it('restores last-set ON after remount', () => {
    const first = renderHook(() => useSearchOverlayKeepResults())
    expect(first.result.current.keepResults).toBe(false)

    act(() => {
      first.result.current.setKeepResults(true)
    })
    expect(first.result.current.keepResults).toBe(true)

    first.unmount()

    // Simulates SearchOverlay remounting content after close/reopen.
    const second = renderHook(() => useSearchOverlayKeepResults())
    expect(second.result.current.keepResults).toBe(true)
  })

  it('restores last-set OFF after remount when the user turned it on then off', () => {
    const first = renderHook(() => useSearchOverlayKeepResults())
    act(() => {
      first.result.current.setKeepResults(true)
    })
    act(() => {
      first.result.current.setKeepResults(false)
    })
    expect(first.result.current.keepResults).toBe(false)

    first.unmount()

    const second = renderHook(() => useSearchOverlayKeepResults())
    expect(second.result.current.keepResults).toBe(false)
  })
})

describe('shouldRetainSearchOverlayContent', () => {
  it('is true when the overlay is open', () => {
    expect(shouldRetainSearchOverlayContent(true, false)).toBe(true)
  })

  it('is true when keep-results is on', () => {
    expect(shouldRetainSearchOverlayContent(false, true)).toBe(true)
  })

  it('is true when both flags are on', () => {
    expect(shouldRetainSearchOverlayContent(true, true)).toBe(true)
  })

  it('is false only when both flags are off', () => {
    expect(shouldRetainSearchOverlayContent(false, false)).toBe(false)
  })
})

describe('searchOverlayRetentionKey', () => {
  it('produces different keys for different vault ids', () => {
    expect(searchOverlayRetentionKey('vault-a', 'hidden')).not.toBe(
      searchOverlayRetentionKey('vault-b', 'hidden'),
    )
  })

  it('produces different keys for the same vault and different lockedView', () => {
    expect(searchOverlayRetentionKey('vault-a', 'hidden')).not.toBe(
      searchOverlayRetentionKey('vault-a', 'revealed'),
    )
  })

  it('treats a null vault as a stable empty prefix', () => {
    expect(searchOverlayRetentionKey(null, 'hidden')).toBe(':hidden')
    expect(searchOverlayRetentionKey('vault-a', 'hidden')).toBe('vault-a:hidden')
  })
})
