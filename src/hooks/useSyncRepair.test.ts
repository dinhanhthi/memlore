import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSyncRepair } from './useSyncRepair'
import { __resetSyncStoreForTests, useSyncStore } from '../stores/syncStore'

vi.mock('../lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('../lib/tauri')>('../lib/tauri')
  return {
    ...actual,
    getSyncStatus: vi.fn(),
    syncRepairFromThisDevice: vi.fn(),
  }
})

import * as tauri from '../lib/tauri'

const refreshedStatus: tauri.SyncStatus = {
  enabled: true,
  configured: true,
  provider: 'gdrive',
  lastSync: 1_700_000_000,
  entriesPending: 4,
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(tauri.getSyncStatus).mockResolvedValue(refreshedStatus)
  __resetSyncStoreForTests()
})

afterEach(() => {
  __resetSyncStoreForTests()
})

describe('useSyncRepair', () => {
  it('returns repair counts and refreshes sync status after the command resolves', async () => {
    const outcome: tauri.SyncMaintenanceResult<tauri.RepairCounts> = {
      queued: false,
      result: { entries: 3, journals: 1 },
    }
    const order: string[] = []
    vi.mocked(tauri.syncRepairFromThisDevice).mockImplementation(async () => {
      order.push('repair')
      return outcome
    })
    vi.mocked(tauri.getSyncStatus).mockImplementation(async () => {
      order.push('refresh')
      return refreshedStatus
    })

    const { result } = renderHook(() => useSyncRepair())

    let repairResult: tauri.SyncMaintenanceResult<tauri.RepairCounts> | undefined
    await act(async () => {
      repairResult = await result.current.repair()
    })

    expect(repairResult).toEqual(outcome)
    expect(tauri.syncRepairFromThisDevice).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['repair', 'refresh'])
    expect(useSyncStore.getState().status).toEqual(refreshedStatus)
  })

  it('passes a queued outcome through and still refreshes sync status', async () => {
    const outcome: tauri.SyncMaintenanceResult<tauri.RepairCounts> = {
      queued: true,
      result: null,
    }
    vi.mocked(tauri.syncRepairFromThisDevice).mockResolvedValue(outcome)

    const { result } = renderHook(() => useSyncRepair())

    let repairResult: tauri.SyncMaintenanceResult<tauri.RepairCounts> | undefined
    await act(async () => {
      repairResult = await result.current.repair()
    })

    expect(repairResult).toEqual(outcome)
    expect(tauri.getSyncStatus).toHaveBeenCalledTimes(1)
    expect(useSyncStore.getState().status).toEqual(refreshedStatus)
  })

  it('propagates rejection and does not refresh sync status', async () => {
    vi.mocked(tauri.syncRepairFromThisDevice).mockRejectedValue(new Error('repair failed'))

    const { result } = renderHook(() => useSyncRepair())

    await act(async () => {
      await expect(result.current.repair()).rejects.toThrow('repair failed')
    })

    expect(tauri.getSyncStatus).not.toHaveBeenCalled()
    expect(useSyncStore.getState().status).toBeNull()
  })
})
