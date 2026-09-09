import { act, renderHook, waitFor } from '@testing-library/react'
import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  __resetEditorRightToLeftEnabledForTests,
  hydrateEditorRightToLeftEnabled,
  isEditorRightToLeftHydrated,
  useEditorRightToLeftEnabled,
  useEditorRightToLeftHydrated,
  useEditorRightToLeftSetting,
} from './useEditorRightToLeftEnabled'

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  mockedInvoke.mockReset()
  mockedInvoke.mockImplementation(async () => null)
  __resetEditorRightToLeftEnabledForTests()
})

describe('useEditorRightToLeftEnabled', () => {
  it('defaults to left-to-right when setting is absent', async () => {
    await hydrateEditorRightToLeftEnabled()

    const { result } = renderHook(() => useEditorRightToLeftEnabled())
    const { result: hydrated } = renderHook(() => useEditorRightToLeftHydrated())

    expect(result.current).toBe(false)
    expect(hydrated.current).toBe(true)
    expect(isEditorRightToLeftHydrated()).toBe(true)
  })

  it("hydrates true when setting is 'true'", async () => {
    mockedInvoke.mockImplementation(async (cmd, args) => {
      if (
        cmd === 'get_setting' &&
        (args as { key: string }).key === 'editor_right_to_left_enabled'
      ) {
        return 'true'
      }
      return null
    })

    await hydrateEditorRightToLeftEnabled()

    const { result } = renderHook(() => useEditorRightToLeftEnabled())
    expect(result.current).toBe(true)
  })

  it('persists and applies the live value', async () => {
    await hydrateEditorRightToLeftEnabled()
    const { result } = renderHook(() => useEditorRightToLeftSetting())

    await act(async () => {
      await result.current.setRightToLeftEnabled(true)
    })

    await waitFor(() => {
      expect(result.current.rightToLeftEnabled).toBe(true)
    })

    const setCall = mockedInvoke.mock.calls.find(([cmd]) => cmd === 'set_setting')
    expect(setCall?.[1]).toEqual({ key: 'editor_right_to_left_enabled', value: 'true' })
  })
})
