import { invoke } from '@tauri-apps/api/core'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useShowMessageMeta } from './useShowMessageMeta'

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  mockedInvoke.mockReset()
  mockedInvoke.mockImplementation(async () => null)
})

describe('useShowMessageMeta', () => {
  it('defaults to true when the setting is absent', async () => {
    const { result } = renderHook(() => useShowMessageMeta())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.showMessageMeta).toBe(true)
  })

  it("reads false when the stored setting is 'false'", async () => {
    mockedInvoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'get_setting' && (args as { key: string }).key === 'ai_show_message_meta') {
        return 'false'
      }
      return null
    })

    const { result } = renderHook(() => useShowMessageMeta())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.showMessageMeta).toBe(false)
  })

  it("reads true when the stored setting is 'true'", async () => {
    mockedInvoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'get_setting' && (args as { key: string }).key === 'ai_show_message_meta') {
        return 'true'
      }
      return null
    })

    const { result } = renderHook(() => useShowMessageMeta())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.showMessageMeta).toBe(true)
  })

  it('setShowMessageMeta persists and updates the live value', async () => {
    const { result } = renderHook(() => useShowMessageMeta())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.setShowMessageMeta(false)
    })

    expect(result.current.showMessageMeta).toBe(false)
    const setCall = mockedInvoke.mock.calls.find(([cmd]) => cmd === 'set_setting')
    expect(setCall?.[1]).toEqual({ key: 'ai_show_message_meta', value: 'false' })
  })

  it('rolls back to the previous value when persisting fails', async () => {
    const { result } = renderHook(() => useShowMessageMeta())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.showMessageMeta).toBe(true)

    mockedInvoke.mockImplementation(async (cmd) => {
      if (cmd === 'set_setting') throw new Error('disk full')
      return null
    })

    await act(async () => {
      await expect(result.current.setShowMessageMeta(false)).rejects.toThrow('disk full')
    })

    expect(result.current.showMessageMeta).toBe(true)
  })
})
