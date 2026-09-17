import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { invoke } from '@tauri-apps/api/core'
import {
  __resetMentionIncludeLockedForTests,
  hydrateMentionIncludeLocked,
  useMentionIncludeLocked,
  useMentionIncludeLockedSetting,
  getMentionIncludeLocked,
  isMentionIncludeLockedHydrated,
} from './useMentionIncludeLocked'

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  mockedInvoke.mockReset()
  mockedInvoke.mockImplementation(async () => null)
  __resetMentionIncludeLockedForTests()
})

describe('useMentionIncludeLocked', () => {
  it('defaults to false before hydration', () => {
    const { result } = renderHook(() => useMentionIncludeLocked())
    expect(result.current).toBe(false)
    expect(getMentionIncludeLocked()).toBe(false)
    expect(isMentionIncludeLockedHydrated()).toBe(false)
  })

  it("hydrates true when setting is 'true'", async () => {
    mockedInvoke.mockImplementation(async (cmd, args) => {
      if (
        cmd === 'get_setting' &&
        (args as { key: string }).key === 'editor_mention_include_locked'
      ) {
        return 'true'
      }
      return null
    })
    await hydrateMentionIncludeLocked()
    const { result } = renderHook(() => useMentionIncludeLocked())
    expect(result.current).toBe(true)
    expect(getMentionIncludeLocked()).toBe(true)
  })

  it('setIncludeLocked persists and updates the live value', async () => {
    await hydrateMentionIncludeLocked()

    const { result } = renderHook(() => useMentionIncludeLockedSetting())
    expect(result.current.includeLocked).toBe(false)

    await act(async () => {
      await result.current.setIncludeLocked(true)
    })

    await waitFor(() => {
      expect(result.current.includeLocked).toBe(true)
    })

    const setCall = mockedInvoke.mock.calls.find(([cmd]) => cmd === 'set_setting')
    expect(setCall?.[1]).toEqual({ key: 'editor_mention_include_locked', value: 'true' })
  })
})
