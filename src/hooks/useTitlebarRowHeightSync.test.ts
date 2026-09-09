import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { invoke } from '@tauri-apps/api/core'
import { useTitlebarRowHeightSync } from './useTitlebarRowHeightSync'
import { useUiStore } from '../stores/uiStore'

const invokeMock = vi.mocked(invoke)

beforeEach(() => {
  invokeMock.mockReset()
  useUiStore.setState({ designSystem: 'signature' })
})

describe('useTitlebarRowHeightSync', () => {
  it('reports 36 for signature on mount and 44 once clay is selected', () => {
    renderHook(() => useTitlebarRowHeightSync())
    expect(invokeMock).toHaveBeenCalledWith('set_titlebar_row_height', { height: 36 })

    act(() => useUiStore.getState().setDesignSystem('clay'))
    expect(invokeMock).toHaveBeenLastCalledWith('set_titlebar_row_height', { height: 44 })
    expect(invokeMock).toHaveBeenCalledTimes(2)
  })

  it('survives a rejected invoke (web preview has no Tauri)', async () => {
    invokeMock.mockRejectedValueOnce(new Error('no tauri'))
    renderHook(() => useTitlebarRowHeightSync())
    await act(async () => {})
    expect(invokeMock).toHaveBeenCalledTimes(1)
  })
})
