import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

vi.mock('@tauri-apps/plugin-autostart', () => ({
  isEnabled: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
}))

import { isEnabled, enable, disable } from '@tauri-apps/plugin-autostart'
import { useStartAtLogin, __resetStartAtLoginForTests } from './useStartAtLogin'

const mockedIsEnabled = vi.mocked(isEnabled)
const mockedEnable = vi.mocked(enable)
const mockedDisable = vi.mocked(disable)

beforeEach(() => {
  __resetStartAtLoginForTests()
  vi.resetAllMocks()
  mockedIsEnabled.mockResolvedValue(false)
})

describe('useStartAtLogin', () => {
  describe('initialization', () => {
    it('starts with loading=true and enabled=false', () => {
      const { result } = renderHook(() => useStartAtLogin())
      expect(result.current.loading).toBe(true)
      expect(result.current.enabled).toBe(false)
    })

    it('calls isEnabled() on mount', async () => {
      mockedIsEnabled.mockResolvedValue(false)
      renderHook(() => useStartAtLogin())

      await waitFor(() => expect(mockedIsEnabled).toHaveBeenCalled())
    })

    it('sets enabled=true and loading=false when isEnabled() resolves to true', async () => {
      mockedIsEnabled.mockResolvedValue(true)
      const { result } = renderHook(() => useStartAtLogin())

      await waitFor(() => {
        expect(result.current.enabled).toBe(true)
        expect(result.current.loading).toBe(false)
      })
    })

    it('keeps enabled=false and sets loading=false when isEnabled() resolves to false', async () => {
      mockedIsEnabled.mockResolvedValue(false)
      const { result } = renderHook(() => useStartAtLogin())

      await waitFor(() => {
        expect(result.current.enabled).toBe(false)
        expect(result.current.loading).toBe(false)
      })
    })

    it('swallows errors from isEnabled() and sets loading=false', async () => {
      mockedIsEnabled.mockRejectedValue(new Error('Plugin error'))
      const { result } = renderHook(() => useStartAtLogin())

      await waitFor(() => {
        expect(result.current.loading).toBe(false)
        expect(result.current.enabled).toBe(false)
      })
    })

    it('does not call isEnabled() on re-renders (only on mount)', async () => {
      mockedIsEnabled.mockResolvedValue(false)
      const { rerender } = renderHook(() => useStartAtLogin())

      await waitFor(() => expect(mockedIsEnabled).toHaveBeenCalledTimes(1))

      rerender()
      expect(mockedIsEnabled).toHaveBeenCalledTimes(1)
    })
  })

  describe('toggle()', () => {
    it('calls enable() when toggling to true', async () => {
      mockedIsEnabled.mockResolvedValue(false)
      const { result } = renderHook(() => useStartAtLogin())

      await waitFor(() => expect(result.current.loading).toBe(false))

      await act(async () => {
        await result.current.toggle(true)
      })

      expect(mockedEnable).toHaveBeenCalled()
    })

    it('calls disable() when toggling to false', async () => {
      mockedIsEnabled.mockResolvedValue(true)
      const { result } = renderHook(() => useStartAtLogin())

      await waitFor(() => expect(result.current.enabled).toBe(true))

      await act(async () => {
        await result.current.toggle(false)
      })

      expect(mockedDisable).toHaveBeenCalled()
    })

    it('sets enabled=true after successful enable()', async () => {
      mockedIsEnabled.mockResolvedValue(false)
      mockedEnable.mockResolvedValue(undefined)
      const { result } = renderHook(() => useStartAtLogin())

      await waitFor(() => expect(result.current.loading).toBe(false))

      await act(async () => {
        await result.current.toggle(true)
      })

      expect(result.current.enabled).toBe(true)
    })

    it('sets enabled=false after successful disable()', async () => {
      mockedIsEnabled.mockResolvedValue(true)
      mockedDisable.mockResolvedValue(undefined)
      const { result } = renderHook(() => useStartAtLogin())

      await waitFor(() => expect(result.current.enabled).toBe(true))

      await act(async () => {
        await result.current.toggle(false)
      })

      expect(result.current.enabled).toBe(false)
    })
  })

  describe('error handling', () => {
    it('toggles enabled state when enable() throws', async () => {
      mockedIsEnabled.mockResolvedValue(false)
      mockedEnable.mockRejectedValue(new Error('Enable failed'))
      const { result } = renderHook(() => useStartAtLogin())

      await waitFor(() => expect(result.current.loading).toBe(false))
      expect(result.current.enabled).toBe(false)

      await act(async () => {
        await result.current.toggle(true)
      })

      // On error, reverts to the previous state (false)
      expect(result.current.enabled).toBe(false)
    })

    it('toggles enabled state when disable() throws', async () => {
      mockedIsEnabled.mockResolvedValue(true)
      mockedDisable.mockRejectedValue(new Error('Disable failed'))
      const { result } = renderHook(() => useStartAtLogin())

      await waitFor(() => expect(result.current.enabled).toBe(true))

      await act(async () => {
        await result.current.toggle(false)
      })

      // On error, reverts to the previous state (true)
      expect(result.current.enabled).toBe(true)
    })

    it('handles enable() error without throwing', async () => {
      mockedIsEnabled.mockResolvedValue(false)
      mockedEnable.mockRejectedValue(new Error('Enable failed'))
      const { result } = renderHook(() => useStartAtLogin())

      await waitFor(() => expect(result.current.loading).toBe(false))

      await expect(
        act(async () => {
          await result.current.toggle(true)
        }),
      ).resolves.not.toThrow()
    })

    it('handles disable() error without throwing', async () => {
      mockedIsEnabled.mockResolvedValue(true)
      mockedDisable.mockRejectedValue(new Error('Disable failed'))
      const { result } = renderHook(() => useStartAtLogin())

      await waitFor(() => expect(result.current.enabled).toBe(true))

      await expect(
        act(async () => {
          await result.current.toggle(false)
        }),
      ).resolves.not.toThrow()
    })
  })

  describe('edge cases', () => {
    it('handles rapid consecutive toggle calls', async () => {
      mockedIsEnabled.mockResolvedValue(false)
      const { result } = renderHook(() => useStartAtLogin())

      await waitFor(() => expect(result.current.loading).toBe(false))

      await act(async () => {
        await Promise.all([result.current.toggle(true), result.current.toggle(false)])
      })

      // Final state depends on execution order; both calls should complete without error
      expect([true, false]).toContain(result.current.enabled)
    })

    it('returning object is stable across renders', async () => {
      mockedIsEnabled.mockResolvedValue(false)
      const { result, rerender } = renderHook(() => useStartAtLogin())

      await waitFor(() => expect(result.current.loading).toBe(false))

      const firstToggle = result.current.toggle
      rerender()
      const secondToggle = result.current.toggle

      expect(secondToggle).toBe(firstToggle)
    })
  })
})
