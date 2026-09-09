import { invoke } from '@tauri-apps/api/core'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useMemoryIncludeProtected } from './useMemoryIncludeProtected'

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  mockedInvoke.mockReset()
  mockedInvoke.mockImplementation(async () => null)
})

describe('useMemoryIncludeProtected', () => {
  it('defaults to false when the setting is absent', async () => {
    const { result } = renderHook(() => useMemoryIncludeProtected())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.includeProtected).toBe(false)
  })

  it("reads true when the stored setting is 'true'", async () => {
    mockedInvoke.mockImplementation(async (cmd, args) => {
      if (
        cmd === 'get_setting' &&
        (args as { key: string }).key === 'ai_memory_include_protected'
      ) {
        return 'true'
      }
      return null
    })

    const { result } = renderHook(() => useMemoryIncludeProtected())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.includeProtected).toBe(true)
  })

  it('setIncludeProtected persists and updates the live value', async () => {
    const { result } = renderHook(() => useMemoryIncludeProtected())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.setIncludeProtected(true)
    })

    expect(result.current.includeProtected).toBe(true)
    const setCall = mockedInvoke.mock.calls.find(([cmd]) => cmd === 'set_setting')
    expect(setCall?.[1]).toEqual({ key: 'ai_memory_include_protected', value: 'true' })
  })

  it('rolls back to the previous value when persisting fails', async () => {
    const { result } = renderHook(() => useMemoryIncludeProtected())
    await waitFor(() => expect(result.current.loading).toBe(false))

    mockedInvoke.mockImplementation(async (cmd) => {
      if (cmd === 'set_setting') throw new Error('disk full')
      return null
    })

    await act(async () => {
      await expect(result.current.setIncludeProtected(true)).rejects.toThrow('disk full')
    })

    expect(result.current.includeProtected).toBe(false)
  })
})
