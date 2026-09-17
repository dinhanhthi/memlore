import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

import { invoke } from '@tauri-apps/api/core'
import { useAppVersion } from './useAppVersion'

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  vi.resetAllMocks()
  mockedInvoke.mockResolvedValue('0.1.0')
})

describe('useAppVersion', () => {
  it('starts null and resolves to the running version', async () => {
    const { result } = renderHook(() => useAppVersion())
    expect(result.current).toBeNull()

    await waitFor(() => expect(result.current).toBe('0.1.0'))
    expect(mockedInvoke).toHaveBeenCalledWith('app_version')
  })

  it('stays null when the command fails', async () => {
    mockedInvoke.mockRejectedValue('no app handle')
    const { result } = renderHook(() => useAppVersion())

    await waitFor(() => expect(mockedInvoke).toHaveBeenCalled())
    expect(result.current).toBeNull()
  })

  it('stays null when the command returns a non-string (web harness mock)', async () => {
    mockedInvoke.mockResolvedValue(null)
    const { result } = renderHook(() => useAppVersion())

    await waitFor(() => expect(mockedInvoke).toHaveBeenCalled())
    expect(result.current).toBeNull()
  })
})
