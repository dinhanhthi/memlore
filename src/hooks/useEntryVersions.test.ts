import { describe, it, expect, beforeEach, vi } from 'vitest'
import React from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PropsWithChildren } from 'react'
import { useEntryVersions } from './useEntryVersions'
import { emitEntryVersionsChanged } from '../lib/versionEvents'
import type { VersionMeta } from '../lib/tauri'
import { useInvisibleLockStore } from '../stores/invisibleLockStore'

vi.mock('../lib/tauri', () => ({
  listEntryVersions: vi.fn(),
  getEntryVersionContent: vi.fn(),
}))

import * as tauri from '../lib/tauri'

const mockListEntryVersions = vi.mocked(tauri.listEntryVersions)
const mockGetEntryVersionContent = vi.mocked(tauri.getEntryVersionContent)

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  return ({ children }: PropsWithChildren) =>
    React.createElement(QueryClientProvider, { client }, children)
}

const makeVersion = (overrides: Partial<VersionMeta> = {}): VersionMeta => ({
  id: 'version-1',
  createdAt: 1744640400,
  previewText: 'Preview text',
  deviceId: 'device-1',
  ...overrides,
})

beforeEach(() => {
  vi.resetAllMocks()
  useInvisibleLockStore.setState({ activeVaultId: null })
})

describe('useEntryVersions', () => {
  it('lists versions for the given entry id', async () => {
    mockListEntryVersions.mockResolvedValue([makeVersion()])
    const { result } = renderHook(() => useEntryVersions('entry-1'), { wrapper: createWrapper() })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(mockListEntryVersions).toHaveBeenCalledWith('entry-1', null)
    expect(result.current.versions).toEqual([makeVersion()])
  })

  it('does not query when entryId is null', () => {
    const { result } = renderHook(() => useEntryVersions(null), { wrapper: createWrapper() })
    expect(mockListEntryVersions).not.toHaveBeenCalled()
    expect(result.current.versions).toEqual([])
  })

  it('getVersionContent converts the returned number[] to Uint8Array', async () => {
    mockListEntryVersions.mockResolvedValue([])
    mockGetEntryVersionContent.mockResolvedValue([1, 2, 3])
    const { result } = renderHook(() => useEntryVersions('entry-1'), { wrapper: createWrapper() })

    const bytes = await result.current.getVersionContent('version-1')

    expect(mockGetEntryVersionContent).toHaveBeenCalledWith('version-1', 'entry-1', null)
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(Array.from(bytes)).toEqual([1, 2, 3])
  })

  it('restore emits memlore:restore-entry-version with entryId + versionId', () => {
    mockListEntryVersions.mockResolvedValue([])
    const { result } = renderHook(() => useEntryVersions('entry-1'), { wrapper: createWrapper() })

    const handler = vi.fn()
    window.addEventListener('memlore:restore-entry-version', handler)
    result.current.restore('version-9')
    window.removeEventListener('memlore:restore-entry-version', handler)

    expect(handler).toHaveBeenCalledTimes(1)
    const event = handler.mock.calls[0][0] as CustomEvent
    expect(event.detail).toEqual({ entryId: 'entry-1', versionId: 'version-9' })
  })

  it('restore is a no-op when entryId is null', () => {
    const handler = vi.fn()
    window.addEventListener('memlore:restore-entry-version', handler)
    const { result } = renderHook(() => useEntryVersions(null), { wrapper: createWrapper() })
    result.current.restore('version-9')
    window.removeEventListener('memlore:restore-entry-version', handler)
    expect(handler).not.toHaveBeenCalled()
  })

  it('invalidates the list when memlore:entry-versions-changed fires for this entry', async () => {
    mockListEntryVersions.mockResolvedValueOnce([]).mockResolvedValueOnce([makeVersion()])
    const { result } = renderHook(() => useEntryVersions('entry-1'), { wrapper: createWrapper() })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
    expect(result.current.versions).toEqual([])

    act(() => {
      emitEntryVersionsChanged('entry-1')
    })

    await waitFor(() => {
      expect(result.current.versions).toEqual([makeVersion()])
    })
    expect(mockListEntryVersions).toHaveBeenCalledTimes(2)
  })

  it('ignores memlore:entry-versions-changed for a different entry', async () => {
    mockListEntryVersions.mockResolvedValue([])
    const { result } = renderHook(() => useEntryVersions('entry-1'), { wrapper: createWrapper() })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    act(() => {
      emitEntryVersionsChanged('entry-2')
    })

    expect(mockListEntryVersions).toHaveBeenCalledTimes(1)
  })
})
