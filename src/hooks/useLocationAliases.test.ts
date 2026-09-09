import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useLocationAliases, __resetLocationAliasesForTests } from './useLocationAliases'
import type { LocationAlias } from '../types/location'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

vi.mock('../lib/tauri', () => ({
  listLocationAliases: vi.fn(),
  createLocationAlias: vi.fn(),
  updateLocationAlias: vi.fn(),
  deleteLocationAlias: vi.fn(),
  findNearbyAliases: vi.fn(),
}))

import * as tauri from '../lib/tauri'

const makeAlias = (overrides: Partial<LocationAlias> = {}): LocationAlias => ({
  id: 'alias-1',
  label: 'Home',
  address: '123 Main St',
  latitude: 37.7749,
  longitude: -122.4194,
  radius_meters: 100,
  ...overrides,
})

beforeEach(() => {
  vi.resetAllMocks()
  __resetLocationAliasesForTests()
})

describe('useLocationAliases', () => {
  it('starts in loading state', () => {
    vi.mocked(tauri.listLocationAliases).mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useLocationAliases())
    expect(result.current.isLoading).toBe(true)
    expect(result.current.aliases).toEqual([])
    expect(result.current.error).toBeNull()
  })

  it('fetches aliases on mount', async () => {
    const aliases = [makeAlias(), makeAlias({ id: 'alias-2', label: 'Work' })]
    vi.mocked(tauri.listLocationAliases).mockResolvedValue(aliases)

    const { result } = renderHook(() => useLocationAliases())

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.aliases).toEqual(aliases)
    expect(result.current.error).toBeNull()
  })

  it('sets error state on backend failure', async () => {
    vi.mocked(tauri.listLocationAliases).mockRejectedValue(new Error('db error'))

    const { result } = renderHook(() => useLocationAliases())

    await waitFor(() => expect(result.current.error).toBe('db error'))
    expect(result.current.isLoading).toBe(false)
  })

  it('creates an alias and refreshes list', async () => {
    const initial = [makeAlias()]
    const created = makeAlias({ id: 'alias-new', label: 'Park' })
    const updated = [...initial, created]

    vi.mocked(tauri.listLocationAliases)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(updated)
    vi.mocked(tauri.createLocationAlias).mockResolvedValue(created)

    const { result } = renderHook(() => useLocationAliases())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.createAlias('Park', '1 Park Ave', 40.0, -75.0)
    })
    expect(tauri.createLocationAlias).toHaveBeenCalledWith(
      'Park',
      '1 Park Ave',
      40.0,
      -75.0,
      undefined,
    )
    expect(result.current.aliases).toHaveLength(2)
  })

  it('deletes an alias and refreshes list', async () => {
    const aliases = [makeAlias(), makeAlias({ id: 'alias-2', label: 'Work' })]
    const afterDelete = [makeAlias()]

    vi.mocked(tauri.listLocationAliases)
      .mockResolvedValueOnce(aliases)
      .mockResolvedValueOnce(afterDelete)
    vi.mocked(tauri.deleteLocationAlias).mockResolvedValue(undefined)

    const { result } = renderHook(() => useLocationAliases())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.deleteAlias('alias-2')
    })
    expect(tauri.deleteLocationAlias).toHaveBeenCalledWith('alias-2')
    expect(result.current.aliases).toHaveLength(1)
  })

  it('shares the module cache across hook instances', async () => {
    const initial = [makeAlias()]
    const created = makeAlias({ id: 'alias-new', label: 'Park' })
    const updated = [...initial, created]

    // Both mounts fetch; keep resolving the initial list until the mutation.
    vi.mocked(tauri.listLocationAliases).mockResolvedValue(initial)
    vi.mocked(tauri.createLocationAlias).mockResolvedValue(created)

    const first = renderHook(() => useLocationAliases())
    const second = renderHook(() => useLocationAliases())
    await waitFor(() => expect(first.result.current.isLoading).toBe(false))
    await waitFor(() => expect(second.result.current.isLoading).toBe(false))

    vi.mocked(tauri.listLocationAliases).mockResolvedValue(updated)
    await act(async () => {
      await first.result.current.createAlias('Park', '1 Park Ave', 40.0, -75.0)
    })

    // The mutation through the first instance is visible to the second.
    expect(second.result.current.aliases).toEqual(updated)
  })

  it('exposes a refresh function', async () => {
    const initial = [makeAlias()]
    const refreshed = [makeAlias(), makeAlias({ id: 'alias-2', label: 'Work' })]
    vi.mocked(tauri.listLocationAliases)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(refreshed)

    const { result } = renderHook(() => useLocationAliases())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      result.current.refresh()
    })
    await waitFor(() => expect(result.current.aliases).toHaveLength(2))
  })
})
