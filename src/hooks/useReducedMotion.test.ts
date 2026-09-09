import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useReducedMotion } from './useReducedMotion'
import { useUiStore } from '../stores/uiStore'

// matchMedia factory — returns a mock MQL with controllable `matches`.
const makeMatchMedia = (matches: boolean) =>
  vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))

beforeEach(() => {
  useUiStore.setState({ reducedMotion: false })
  document.documentElement.classList.remove('reduce-motion')
  // Default OS: no reduced motion preference
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: makeMatchMedia(false),
  })
})

afterEach(() => {
  document.documentElement.classList.remove('reduce-motion')
})

describe('useReducedMotion', () => {
  it('returns false and class is absent when both store and OS are false', () => {
    const { result } = renderHook(() => useReducedMotion())
    expect(result.current.prefersReducedMotion).toBe(false)
    expect(document.documentElement.classList.contains('reduce-motion')).toBe(false)
  })

  it('returns true and adds class when store reducedMotion=true', () => {
    useUiStore.setState({ reducedMotion: true })
    const { result } = renderHook(() => useReducedMotion())
    expect(result.current.prefersReducedMotion).toBe(true)
    expect(document.documentElement.classList.contains('reduce-motion')).toBe(true)
  })

  it('returns true and adds class when OS prefers-reduced-motion matches=true', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: makeMatchMedia(true),
    })
    const { result } = renderHook(() => useReducedMotion())
    expect(result.current.prefersReducedMotion).toBe(true)
    expect(document.documentElement.classList.contains('reduce-motion')).toBe(true)
  })

  it('returns true when both store and OS are true', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: makeMatchMedia(true),
    })
    useUiStore.setState({ reducedMotion: true })
    const { result } = renderHook(() => useReducedMotion())
    expect(result.current.prefersReducedMotion).toBe(true)
    expect(document.documentElement.classList.contains('reduce-motion')).toBe(true)
  })

  it('removes class when store is toggled back to false (OS also false)', () => {
    useUiStore.setState({ reducedMotion: true })
    const { result } = renderHook(() => useReducedMotion())
    expect(result.current.prefersReducedMotion).toBe(true)
    expect(document.documentElement.classList.contains('reduce-motion')).toBe(true)

    act(() => {
      useUiStore.getState().setReducedMotion(false)
    })

    expect(result.current.prefersReducedMotion).toBe(false)
    expect(document.documentElement.classList.contains('reduce-motion')).toBe(false)
  })

  it('OS matchMedia change event adds class when it fires with matches=true', () => {
    let changeListener: ((e: { matches: boolean }) => void) | null = null
    const mockMql = {
      matches: false,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addEventListener: vi.fn((_: string, cb: (e: { matches: boolean }) => void) => {
        changeListener = cb
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockReturnValue(mockMql),
    })

    renderHook(() => useReducedMotion())
    expect(document.documentElement.classList.contains('reduce-motion')).toBe(false)

    act(() => {
      if (changeListener) changeListener({ matches: true })
    })

    expect(document.documentElement.classList.contains('reduce-motion')).toBe(true)
  })
})
