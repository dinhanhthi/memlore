import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpStatus } from '../lib/tauri'

vi.mock('../lib/tauri', () => ({
  getMcpStatus: vi.fn(),
}))

import { getMcpStatus } from '../lib/tauri'
import { useMcpStatus } from './useMcpStatus'

const mockedGet = vi.mocked(getMcpStatus)

const STOPPED: McpStatus = {
  running: false,
  socketPath: '/tmp/mcp.sock',
  binaryPath: '/Users/thi/git/memlore/src-tauri/target/debug/memlore',
}

const RUNNING: McpStatus = {
  running: true,
  socketPath: '/tmp/mcp.sock',
  binaryPath: '/Users/thi/git/memlore/src-tauri/target/debug/memlore',
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useMcpStatus', () => {
  it('starts loading with no status, then resolves the mcp_status snapshot', async () => {
    mockedGet.mockResolvedValue(STOPPED)
    const { result } = renderHook(() => useMcpStatus())

    expect(result.current.loading).toBe(true)
    expect(result.current.status).toBeNull()
    expect(result.current.error).toBeNull()

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.status).toEqual(STOPPED)
    expect(result.current.error).toBeNull()
    expect(mockedGet).toHaveBeenCalledTimes(1)
  })

  it('refresh() re-fetches so a toggle can update running state', async () => {
    mockedGet.mockResolvedValueOnce(STOPPED).mockResolvedValueOnce(RUNNING)
    const { result } = renderHook(() => useMcpStatus())
    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.status?.running).toBe(false)

    await act(async () => {
      await result.current.refresh()
    })

    expect(result.current.status).toEqual(RUNNING)
    expect(mockedGet).toHaveBeenCalledTimes(2)
  })

  it('settles loading and records an error when mcp_status rejects', async () => {
    mockedGet.mockRejectedValue(new Error('Encryption key not initialized — app is locked'))
    const { result } = renderHook(() => useMcpStatus())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.status).toBeNull()
    expect(result.current.error).toBe('Encryption key not initialized — app is locked')
  })

  it('does not apply a late resolve after unmount', async () => {
    let resolveStatus: (value: McpStatus) => void = () => {}
    mockedGet.mockImplementation(
      () =>
        new Promise<McpStatus>((resolve) => {
          resolveStatus = resolve
        }),
    )
    const { result, unmount } = renderHook(() => useMcpStatus())
    expect(result.current.loading).toBe(true)

    unmount()
    resolveStatus(RUNNING)

    await act(async () => {
      await Promise.resolve()
    })
    expect(mockedGet).toHaveBeenCalledTimes(1)
  })
})
