import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { invoke } from '@tauri-apps/api/core'
import { DEFAULT_LAYOUT_PRESET } from '../lib/layoutPreset'
import {
  __resetLayoutPresetForTests,
  getLayoutPreset,
  hydrateLayoutPreset,
  setLayoutPreset,
  useLayoutFlags,
  useLayoutPreset,
} from './useLayoutPreset'

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  mockedInvoke.mockReset()
  mockedInvoke.mockImplementation(async () => null)
  __resetLayoutPresetForTests()
})

describe('useLayoutPreset', () => {
  it('defaults to DEFAULT_LAYOUT_PRESET and both flags false before hydration', () => {
    const { result: preset } = renderHook(() => useLayoutPreset())
    const { result: flags } = renderHook(() => useLayoutFlags())

    expect(preset.current).toBe(DEFAULT_LAYOUT_PRESET)
    expect(flags.current).toEqual({ sidebarRight: false, panelAfterMain: false })
  })

  it("hydrates 'main-panel-sidebar' with both flags true", async () => {
    mockedInvoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'get_setting' && (args as { key: string }).key === 'layout_preset') {
        return 'main-panel-sidebar'
      }
      return null
    })

    await hydrateLayoutPreset()

    const { result: preset } = renderHook(() => useLayoutPreset())
    const { result: flags } = renderHook(() => useLayoutFlags())

    expect(preset.current).toBe('main-panel-sidebar')
    expect(flags.current).toEqual({ sidebarRight: true, panelAfterMain: true })
  })

  it("falls back to the default when hydrating 'garbage'", async () => {
    mockedInvoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'get_setting' && (args as { key: string }).key === 'layout_preset') {
        return 'garbage'
      }
      return null
    })

    await hydrateLayoutPreset()

    const { result: preset } = renderHook(() => useLayoutPreset())
    const { result: flags } = renderHook(() => useLayoutFlags())

    expect(preset.current).toBe(DEFAULT_LAYOUT_PRESET)
    expect(flags.current).toEqual({ sidebarRight: false, panelAfterMain: false })
  })

  it("setLayoutPreset('sidebar-main-panel') persists and updates get()", async () => {
    await act(async () => {
      await setLayoutPreset('sidebar-main-panel')
    })

    await waitFor(() => {
      expect(getLayoutPreset()).toBe('sidebar-main-panel')
    })

    const setCall = mockedInvoke.mock.calls.find(([cmd]) => cmd === 'set_setting')
    expect(setCall?.[1]).toEqual({ key: 'layout_preset', value: 'sidebar-main-panel' })
  })
})
