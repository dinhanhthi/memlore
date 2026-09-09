import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useIsTruncated } from './useIsTruncated'

function makeRef(widths: { scrollWidth: number; clientWidth: number }) {
  const el = document.createElement('span')
  Object.defineProperty(el, 'scrollWidth', { value: widths.scrollWidth, configurable: true })
  Object.defineProperty(el, 'clientWidth', { value: widths.clientWidth, configurable: true })
  return { current: el }
}

describe('useIsTruncated', () => {
  it('returns false when ref is null', () => {
    const ref = { current: null }
    const { result } = renderHook(() => useIsTruncated(ref))
    expect(result.current).toBe(false)
  })

  it('returns false when content fits', () => {
    const ref = makeRef({ scrollWidth: 50, clientWidth: 100 })
    const { result } = renderHook(() => useIsTruncated(ref))
    expect(result.current).toBe(false)
  })

  it('returns true when content overflows', () => {
    const ref = makeRef({ scrollWidth: 150, clientWidth: 100 })
    const { result } = renderHook(() => useIsTruncated(ref))
    expect(result.current).toBe(true)
  })

  it('recomputes when deps change', () => {
    const ref = makeRef({ scrollWidth: 50, clientWidth: 100 })
    const { result, rerender } = renderHook(
      ({ name }: { name: string }) => useIsTruncated(ref, [name]),
      { initialProps: { name: 'Short' } },
    )
    expect(result.current).toBe(false)

    Object.defineProperty(ref.current, 'scrollWidth', { value: 200, configurable: true })
    rerender({ name: 'A much longer journal name' })
    expect(result.current).toBe(true)
  })
})
