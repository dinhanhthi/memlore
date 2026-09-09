import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { invoke } from '@tauri-apps/api/core'
import {
  __resetEditorMediaStripCollapsedForTests,
  hydrateEditorMediaStripCollapsed,
  useEditorMediaStripCollapsed,
  useEditorMediaStripCollapsedHydrated,
  useEditorMediaStripCollapsedSetting,
  isEditorMediaStripCollapsedHydrated,
  setEditorMediaStripCollapsed,
  getEditorMediaStripCollapsed,
} from './useEditorMediaStripCollapsed'

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  mockedInvoke.mockReset()
  mockedInvoke.mockImplementation(async () => null)
  __resetEditorMediaStripCollapsedForTests()
})

describe('useEditorMediaStripCollapsed', () => {
  it('defaults to collapsed before hydration', () => {
    const { result } = renderHook(() => useEditorMediaStripCollapsed())
    expect(result.current).toBe(true)
  })

  it('hydrates collapsed when setting is absent', async () => {
    mockedInvoke.mockImplementation(async () => null)
    await hydrateEditorMediaStripCollapsed()
    const { result } = renderHook(() => useEditorMediaStripCollapsed())
    const { result: hydrated } = renderHook(() => useEditorMediaStripCollapsedHydrated())
    expect(result.current).toBe(true)
    expect(hydrated.current).toBe(true)
    expect(isEditorMediaStripCollapsedHydrated()).toBe(true)
  })

  it("hydrates expanded when setting is 'false'", async () => {
    mockedInvoke.mockImplementation(async (cmd, args) => {
      if (
        cmd === 'get_setting' &&
        (args as { key: string }).key === 'editor_media_strip_collapsed'
      ) {
        return 'false'
      }
      return null
    })
    await hydrateEditorMediaStripCollapsed()
    const { result } = renderHook(() => useEditorMediaStripCollapsed())
    expect(result.current).toBe(false)
  })

  it("hydrates true when setting is 'true'", async () => {
    mockedInvoke.mockImplementation(async (cmd, args) => {
      if (
        cmd === 'get_setting' &&
        (args as { key: string }).key === 'editor_media_strip_collapsed'
      ) {
        return 'true'
      }
      return null
    })
    await hydrateEditorMediaStripCollapsed()
    const { result } = renderHook(() => useEditorMediaStripCollapsed())
    expect(result.current).toBe(true)
  })

  it('does not overwrite a user write that finished before hydrate', async () => {
    let resolveGet: ((value: string | null) => void) | undefined
    mockedInvoke.mockImplementation(async (cmd, args) => {
      if (
        cmd === 'get_setting' &&
        (args as { key: string }).key === 'editor_media_strip_collapsed'
      ) {
        return new Promise<string | null>((resolve) => {
          resolveGet = resolve
        })
      }
      return null
    })

    const hydratePromise = hydrateEditorMediaStripCollapsed()
    await act(async () => {
      await setEditorMediaStripCollapsed(false)
    })
    expect(getEditorMediaStripCollapsed()).toBe(false)

    resolveGet?.('true')
    await hydratePromise

    expect(getEditorMediaStripCollapsed()).toBe(false)
  })

  it('setMediaStripCollapsed persists and updates the live value', async () => {
    mockedInvoke.mockImplementation(async () => null)
    await hydrateEditorMediaStripCollapsed()

    const { result } = renderHook(() => useEditorMediaStripCollapsedSetting())
    expect(result.current.mediaStripCollapsed).toBe(true)

    await act(async () => {
      await result.current.setMediaStripCollapsed(false)
    })

    await waitFor(() => {
      expect(result.current.mediaStripCollapsed).toBe(false)
    })

    const setCall = mockedInvoke.mock.calls.find(([cmd]) => cmd === 'set_setting')
    expect(setCall?.[1]).toEqual({ key: 'editor_media_strip_collapsed', value: 'false' })
  })

  it('setEditorMediaStripCollapsed leaves state unchanged when setSetting fails', async () => {
    mockedInvoke.mockImplementation(async (cmd) => {
      if (cmd === 'set_setting') {
        throw new Error('disk full')
      }
      return null
    })
    await hydrateEditorMediaStripCollapsed()

    await expect(setEditorMediaStripCollapsed(false)).rejects.toThrow('disk full')
    expect(getEditorMediaStripCollapsed()).toBe(true)
  })

  it('useEditorMediaStripCollapsedSetting exposes a reactive hydrated flag', async () => {
    mockedInvoke.mockImplementation(async () => null)

    const { result } = renderHook(() => useEditorMediaStripCollapsedSetting())
    expect(result.current.hydrated).toBe(false)

    await act(async () => {
      await hydrateEditorMediaStripCollapsed()
    })

    await waitFor(() => {
      expect(result.current.hydrated).toBe(true)
    })
  })
})
