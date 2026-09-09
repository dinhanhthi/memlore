import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { invoke } from '@tauri-apps/api/core'
import {
  __resetEditorJustifyEnabledForTests,
  hydrateEditorJustifyEnabled,
  useEditorJustifyEnabled,
  useEditorJustifyHydrated,
  useEditorJustifySetting,
  isEditorJustifyHydrated,
} from './useEditorJustifyEnabled'

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  mockedInvoke.mockReset()
  mockedInvoke.mockImplementation(async () => null)
  __resetEditorJustifyEnabledForTests()
})

describe('useEditorJustifyEnabled', () => {
  it('hydrates false when setting is absent', async () => {
    mockedInvoke.mockImplementation(async () => null)
    await hydrateEditorJustifyEnabled()
    const { result } = renderHook(() => useEditorJustifyEnabled())
    const { result: hydrated } = renderHook(() => useEditorJustifyHydrated())
    expect(result.current).toBe(false)
    expect(hydrated.current).toBe(true)
    expect(isEditorJustifyHydrated()).toBe(true)
  })

  it("hydrates true when setting is 'true'", async () => {
    mockedInvoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'get_setting' && (args as { key: string }).key === 'editor_justify_enabled') {
        return 'true'
      }
      return null
    })
    await hydrateEditorJustifyEnabled()
    const { result } = renderHook(() => useEditorJustifyEnabled())
    expect(result.current).toBe(true)
  })

  it('setJustifyEnabled persists and updates the live value', async () => {
    mockedInvoke.mockImplementation(async () => null)
    await hydrateEditorJustifyEnabled()

    const { result } = renderHook(() => useEditorJustifySetting())
    expect(result.current.justifyEnabled).toBe(false)

    await act(async () => {
      await result.current.setJustifyEnabled(true)
    })

    await waitFor(() => {
      expect(result.current.justifyEnabled).toBe(true)
    })

    const setCall = mockedInvoke.mock.calls.find(([cmd]) => cmd === 'set_setting')
    expect(setCall?.[1]).toEqual({ key: 'editor_justify_enabled', value: 'true' })
  })
})
