import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { invoke } from '@tauri-apps/api/core'
import {
  __resetEditorMathEnabledForTests,
  hydrateEditorMathEnabled,
  useEditorMathEnabled,
  useEditorMathHydrated,
  useEditorMathSetting,
  isEditorMathHydrated,
} from './useEditorMathEnabled'

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  mockedInvoke.mockReset()
  mockedInvoke.mockImplementation(async () => null)
  __resetEditorMathEnabledForTests()
})

describe('useEditorMathEnabled', () => {
  it('hydrates false when setting is absent', async () => {
    mockedInvoke.mockImplementation(async () => null)
    await hydrateEditorMathEnabled()
    const { result } = renderHook(() => useEditorMathEnabled())
    const { result: hydrated } = renderHook(() => useEditorMathHydrated())
    expect(result.current).toBe(false)
    expect(hydrated.current).toBe(true)
    expect(isEditorMathHydrated()).toBe(true)
  })

  it("hydrates true when setting is 'true'", async () => {
    mockedInvoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'get_setting' && (args as { key: string }).key === 'editor_math_enabled') {
        return 'true'
      }
      return null
    })
    await hydrateEditorMathEnabled()
    const { result } = renderHook(() => useEditorMathEnabled())
    expect(result.current).toBe(true)
  })

  it('setMathEnabled persists and updates the live value', async () => {
    mockedInvoke.mockImplementation(async () => null)
    await hydrateEditorMathEnabled()

    const { result } = renderHook(() => useEditorMathSetting())
    expect(result.current.mathEnabled).toBe(false)

    await act(async () => {
      await result.current.setMathEnabled(true)
    })

    await waitFor(() => {
      expect(result.current.mathEnabled).toBe(true)
    })

    const setCall = mockedInvoke.mock.calls.find(([cmd]) => cmd === 'set_setting')
    expect(setCall?.[1]).toEqual({ key: 'editor_math_enabled', value: 'true' })
  })
})
