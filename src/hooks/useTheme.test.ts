import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useTheme } from './useTheme'
import { useUiStore } from '../stores/uiStore'

// Default matchMedia stub: OS is light (matches=false for dark query)
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
  vi.resetAllMocks()
  useUiStore.setState({
    sidebarCollapsed: false,
    theme: 'light',
    designSystem: 'signature',
    surfaceStyle: 'deep',
    reducedMotion: false,
  })
  document.documentElement.classList.remove('dark')
  // Default: OS is light
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: makeMatchMedia(false),
  })
})

describe('useTheme', () => {
  it('returns current theme from store', () => {
    const { result } = renderHook(() => useTheme())
    expect(result.current.theme).toBe('light')
  })

  it("resolves 'light' and omits the .dark class when theme='light'", async () => {
    const { result } = renderHook(() => useTheme())
    await waitFor(() => expect(result.current.resolvedTheme).toBe('light'))
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it("resolves 'dark' and adds the .dark class when theme='dark'", async () => {
    useUiStore.setState({ theme: 'dark' })
    const { result } = renderHook(() => useTheme())
    await waitFor(() => expect(result.current.resolvedTheme).toBe('dark'))
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('coerces a leftover system theme to dark and keeps the .dark class', async () => {
    useUiStore.setState({ theme: 'system' as unknown as 'light' })
    const { result } = renderHook(() => useTheme())
    await waitFor(() => expect(result.current.resolvedTheme).toBe('dark'))
    expect(result.current.theme).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  describe('toggleTheme cycle', () => {
    it('cycles light → dark', async () => {
      const { result } = renderHook(() => useTheme())
      result.current.toggleTheme()
      await waitFor(() => expect(result.current.theme).toBe('dark'))
    })

    it('cycles dark → light', async () => {
      useUiStore.setState({ theme: 'dark' })
      const { result } = renderHook(() => useTheme())
      result.current.toggleTheme()
      await waitFor(() => expect(result.current.theme).toBe('light'))
    })

    it('full cycle returns to starting value after 2 toggles', async () => {
      const { result } = renderHook(() => useTheme())
      result.current.toggleTheme()
      result.current.toggleTheme()
      await waitFor(() => expect(result.current.theme).toBe('light'))
    })
  })

  describe('clean design system', () => {
    it("with theme='light', resolvedTheme is 'light' and root loses .dark", async () => {
      useUiStore.setState({ designSystem: 'clean', theme: 'light' })
      const { result } = renderHook(() => useTheme())
      await waitFor(() => expect(result.current.resolvedTheme).toBe('light'))
      expect(document.documentElement.classList.contains('dark')).toBe(false)
    })

    it("with theme='dark', resolvedTheme is 'dark' and root gains .dark", async () => {
      useUiStore.setState({ designSystem: 'clean', theme: 'dark' })
      const { result } = renderHook(() => useTheme())
      await waitFor(() => expect(result.current.resolvedTheme).toBe('dark'))
      expect(document.documentElement.classList.contains('dark')).toBe(true)
    })

    it("switching designSystem back to 'signature' honors persisted theme='light'", async () => {
      useUiStore.setState({ designSystem: 'clean', theme: 'light' })
      const { result } = renderHook(() => useTheme())
      await waitFor(() => expect(result.current.resolvedTheme).toBe('light'))

      act(() => {
        useUiStore.setState({ designSystem: 'signature' })
      })

      await waitFor(() => expect(result.current.resolvedTheme).toBe('light'))
      expect(result.current.theme).toBe('light')
      expect(document.documentElement.classList.contains('dark')).toBe(false)
    })
  })

  describe('lumen surface light gate', () => {
    it('Signature + lumen forces resolvedTheme dark even if stored theme is light', async () => {
      useUiStore.setState({ designSystem: 'signature', surfaceStyle: 'lumen', theme: 'light' })
      const { result } = renderHook(() => useTheme())
      await waitFor(() => expect(result.current.resolvedTheme).toBe('dark'))
      expect(result.current.theme).toBe('light')
      expect(document.documentElement.classList.contains('dark')).toBe(true)
    })

    it("Clean + stored lumen still honors theme='light'", async () => {
      useUiStore.setState({ designSystem: 'clean', surfaceStyle: 'lumen', theme: 'light' })
      const { result } = renderHook(() => useTheme())
      await waitFor(() => expect(result.current.resolvedTheme).toBe('light'))
      expect(document.documentElement.classList.contains('dark')).toBe(false)
    })
  })
})
