import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { invoke } from '@tauri-apps/api/core'
import {
  __resetEditorDistractionEnabledForTests,
  hydrateEditorDistractionEnabled,
  useEditorDistractionEnabled,
  useEditorDistractionHydrated,
  useEditorDistractionSetting,
  isEditorDistractionHydrated,
} from './useEditorDistractionEnabled'
import { useEditorDistractionStore } from '../stores/editorDistractionStore'

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  mockedInvoke.mockReset()
  mockedInvoke.mockImplementation(async () => null)
  __resetEditorDistractionEnabledForTests()
  useEditorDistractionStore.setState({ distractionMode: false })
})

describe('useEditorDistractionEnabled', () => {
  it('defaults to true before hydration', () => {
    const { result } = renderHook(() => useEditorDistractionEnabled())
    expect(result.current).toBe(true)
  })

  it('hydrates true when setting is absent', async () => {
    mockedInvoke.mockImplementation(async () => null)
    await hydrateEditorDistractionEnabled()
    const { result } = renderHook(() => useEditorDistractionEnabled())
    const { result: hydrated } = renderHook(() => useEditorDistractionHydrated())
    expect(result.current).toBe(true)
    expect(hydrated.current).toBe(true)
    expect(isEditorDistractionHydrated()).toBe(true)
  })

  it("hydrates false when setting is 'false'", async () => {
    mockedInvoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'get_setting' && (args as { key: string }).key === 'editor_distraction_enabled') {
        return 'false'
      }
      return null
    })
    await hydrateEditorDistractionEnabled()
    const { result } = renderHook(() => useEditorDistractionEnabled())
    expect(result.current).toBe(false)
  })

  it('setDistractionEnabled persists and updates the live value', async () => {
    mockedInvoke.mockImplementation(async () => null)
    await hydrateEditorDistractionEnabled()

    const { result } = renderHook(() => useEditorDistractionSetting())
    expect(result.current.distractionEnabled).toBe(true)

    await act(async () => {
      await result.current.setDistractionEnabled(false)
    })

    await waitFor(() => {
      expect(result.current.distractionEnabled).toBe(false)
    })

    const setCall = mockedInvoke.mock.calls.find(([cmd]) => cmd === 'set_setting')
    expect(setCall?.[1]).toEqual({ key: 'editor_distraction_enabled', value: 'false' })
  })

  it('setDistractionEnabled(false) clears active distraction session state', async () => {
    mockedInvoke.mockImplementation(async () => null)
    await hydrateEditorDistractionEnabled()
    useEditorDistractionStore.getState().setDistractionMode(true)

    const { result } = renderHook(() => useEditorDistractionSetting())
    await act(async () => {
      await result.current.setDistractionEnabled(false)
    })

    expect(useEditorDistractionStore.getState().distractionMode).toBe(false)
  })
})
