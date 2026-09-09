import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { invoke } from '@tauri-apps/api/core'
import {
  __resetEditorFixedTitleEnabledForTests,
  hydrateEditorFixedTitleEnabled,
  useEditorFixedTitleEnabled,
  useEditorFixedTitleHydrated,
  useEditorFixedTitleSetting,
  isEditorFixedTitleHydrated,
} from './useEditorFixedTitleEnabled'

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  mockedInvoke.mockReset()
  mockedInvoke.mockImplementation(async () => null)
  __resetEditorFixedTitleEnabledForTests()
})

describe('useEditorFixedTitleEnabled', () => {
  it('hydrates false when setting is absent', async () => {
    mockedInvoke.mockImplementation(async () => null)
    await hydrateEditorFixedTitleEnabled()
    const { result } = renderHook(() => useEditorFixedTitleEnabled())
    const { result: hydrated } = renderHook(() => useEditorFixedTitleHydrated())
    expect(result.current).toBe(false)
    expect(hydrated.current).toBe(true)
    expect(isEditorFixedTitleHydrated()).toBe(true)
  })

  it("hydrates true when setting is 'true'", async () => {
    mockedInvoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'get_setting' && (args as { key: string }).key === 'editor_fixed_title_enabled') {
        return 'true'
      }
      return null
    })
    await hydrateEditorFixedTitleEnabled()
    const { result } = renderHook(() => useEditorFixedTitleEnabled())
    expect(result.current).toBe(true)
  })

  it('setFixedTitleEnabled persists and updates the live value', async () => {
    mockedInvoke.mockImplementation(async () => null)
    await hydrateEditorFixedTitleEnabled()

    const { result } = renderHook(() => useEditorFixedTitleSetting())
    expect(result.current.fixedTitleEnabled).toBe(false)

    await act(async () => {
      await result.current.setFixedTitleEnabled(true)
    })

    await waitFor(() => {
      expect(result.current.fixedTitleEnabled).toBe(true)
    })

    const setCall = mockedInvoke.mock.calls.find(([cmd]) => cmd === 'set_setting')
    expect(setCall?.[1]).toEqual({ key: 'editor_fixed_title_enabled', value: 'true' })
  })
})
