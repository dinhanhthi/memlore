import { invoke } from '@tauri-apps/api/core'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useMemoryAllowHosted } from './useMemoryAllowHosted'

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  mockedInvoke.mockReset()
  mockedInvoke.mockImplementation(async () => null)
})

describe('useMemoryAllowHosted', () => {
  it('defaults to false when the setting is absent', async () => {
    const { result } = renderHook(() => useMemoryAllowHosted())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.allowHosted).toBe(false)
  })

  it("reads true when the stored setting is 'true'", async () => {
    mockedInvoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'get_setting' && (args as { key: string }).key === 'ai_memory_allow_hosted') {
        return 'true'
      }
      return null
    })

    const { result } = renderHook(() => useMemoryAllowHosted())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.allowHosted).toBe(true)
  })

  it('setAllowHosted(true) calls the atomic command and updates the live value', async () => {
    mockedInvoke.mockImplementation(async (cmd) => {
      if (cmd === 'set_memory_allow_hosted') {
        return { allowHosted: true, memoryEnabled: true }
      }
      return null
    })
    const { result } = renderHook(() => useMemoryAllowHosted())
    await waitFor(() => expect(result.current.loading).toBe(false))

    let outcome: { memoryEnabled: boolean } | undefined
    await act(async () => {
      outcome = await result.current.setAllowHosted(true)
    })

    expect(result.current.allowHosted).toBe(true)
    expect(outcome).toEqual({ memoryEnabled: true })
    const call = mockedInvoke.mock.calls.find(([cmd]) => cmd === 'set_memory_allow_hosted')
    expect(call?.[1]).toEqual({ next: true })
    // The old two-call flow (setSetting + reject_disallowed_memory_slots) is
    // gone — everything rides the single atomic command now.
    expect(mockedInvoke.mock.calls.some(([cmd]) => cmd === 'set_setting')).toBe(false)
    expect(mockedInvoke.mock.calls.some(([cmd]) => cmd === 'reject_disallowed_memory_slots')).toBe(
      false,
    )
  })

  it('setAllowHosted(false) calls the atomic command with next=false', async () => {
    mockedInvoke.mockImplementation(async (cmd) => {
      if (cmd === 'set_memory_allow_hosted') {
        return { allowHosted: false, memoryEnabled: false }
      }
      return null
    })
    const { result } = renderHook(() => useMemoryAllowHosted())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.setAllowHosted(false)
    })

    expect(result.current.allowHosted).toBe(false)
    const call = mockedInvoke.mock.calls.find(([cmd]) => cmd === 'set_memory_allow_hosted')
    expect(call?.[1]).toEqual({ next: false })
  })

  it('rolls back to the previous value when the command throws', async () => {
    const { result } = renderHook(() => useMemoryAllowHosted())
    await waitFor(() => expect(result.current.loading).toBe(false))

    mockedInvoke.mockImplementation(async (cmd) => {
      if (cmd === 'set_memory_allow_hosted') throw new Error('disk full')
      return null
    })

    await act(async () => {
      await expect(result.current.setAllowHosted(true)).rejects.toThrow('disk full')
    })

    expect(result.current.allowHosted).toBe(false)
  })
})
