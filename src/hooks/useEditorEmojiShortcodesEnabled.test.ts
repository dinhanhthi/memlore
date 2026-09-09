import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { invoke } from '@tauri-apps/api/core'
import {
  __resetEditorEmojiShortcodesEnabledForTests,
  hydrateEditorEmojiShortcodesEnabled,
  useEditorEmojiShortcodesEnabled,
  useEditorEmojiShortcodesSetting,
  isEditorEmojiShortcodesHydrated,
} from './useEditorEmojiShortcodesEnabled'

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  mockedInvoke.mockReset()
  mockedInvoke.mockImplementation(async () => null)
  __resetEditorEmojiShortcodesEnabledForTests()
})

describe('useEditorEmojiShortcodesEnabled', () => {
  it('hydrates false when setting is absent', async () => {
    mockedInvoke.mockImplementation(async () => null)
    await hydrateEditorEmojiShortcodesEnabled()
    const { result } = renderHook(() => useEditorEmojiShortcodesEnabled())
    expect(result.current).toBe(false)
    expect(isEditorEmojiShortcodesHydrated()).toBe(true)
  })

  it("hydrates true when setting is 'true'", async () => {
    mockedInvoke.mockImplementation(async (cmd, args) => {
      if (
        cmd === 'get_setting' &&
        (args as { key: string }).key === 'editor_emoji_shortcodes_enabled'
      ) {
        return 'true'
      }
      return null
    })
    await hydrateEditorEmojiShortcodesEnabled()
    const { result } = renderHook(() => useEditorEmojiShortcodesEnabled())
    expect(result.current).toBe(true)
  })

  it('setEmojiShortcodesEnabled persists and updates the live value', async () => {
    mockedInvoke.mockImplementation(async () => null)
    await hydrateEditorEmojiShortcodesEnabled()

    const { result } = renderHook(() => useEditorEmojiShortcodesSetting())
    expect(result.current.emojiShortcodesEnabled).toBe(false)

    await act(async () => {
      await result.current.setEmojiShortcodesEnabled(true)
    })

    await waitFor(() => {
      expect(result.current.emojiShortcodesEnabled).toBe(true)
    })

    const setCall = mockedInvoke.mock.calls.find(([cmd]) => cmd === 'set_setting')
    expect(setCall?.[1]).toEqual({ key: 'editor_emoji_shortcodes_enabled', value: 'true' })
  })
})
