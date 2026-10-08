import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('useCapabilities', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('desktop: all capabilities true regardless of the store', async () => {
    vi.stubEnv('VITE_MEMLORE_PLATFORM', '')
    vi.resetModules()
    const { useCapabilities } = await import('./useCapabilities')
    const { useCapabilitiesStore } = await import('../stores/capabilitiesStore')
    useCapabilitiesStore.getState().setWrites(false)
    const { result } = renderHook(() => useCapabilities())
    expect(result.current.writes).toBe(true)
    expect(result.current.ai).toBe(true)
  })

  it('web: writes comes from the store, everything else false', async () => {
    vi.stubEnv('VITE_MEMLORE_PLATFORM', 'web')
    vi.resetModules()
    const { useCapabilities } = await import('./useCapabilities')
    const { useCapabilitiesStore } = await import('../stores/capabilitiesStore')
    useCapabilitiesStore.getState().setWrites(false)
    const { result } = renderHook(() => useCapabilities())
    expect(result.current.writes).toBe(false)
    expect(result.current.ai).toBe(false)
    act(() => useCapabilitiesStore.getState().setWrites(true))
    expect(result.current.writes).toBe(true)
    expect(result.current.ai).toBe(false)
  })

  it('desktop: runtime web flags never narrow anything', async () => {
    vi.stubEnv('VITE_MEMLORE_PLATFORM', '')
    vi.resetModules()
    const { useCapabilities } = await import('./useCapabilities')
    const { useCapabilitiesStore } = await import('../stores/capabilitiesStore')
    useCapabilitiesStore.getState().setWebCapabilities({ outboxV2: false, monthIndex: false })
    const { result } = renderHook(() => useCapabilities())
    for (const [flag, value] of Object.entries(result.current)) expect(value, flag).toBe(true)
  })

  it('web: taxonomyCreate and deleteEntries need writes AND a v2 desktop', async () => {
    vi.stubEnv('VITE_MEMLORE_PLATFORM', 'web')
    vi.resetModules()
    const { useCapabilities } = await import('./useCapabilities')
    const { useCapabilitiesStore } = await import('../stores/capabilitiesStore')
    const store = useCapabilitiesStore.getState()
    store.setWrites(true)
    store.setWebCapabilities({ outboxV2: false, monthIndex: false })
    const { result } = renderHook(() => useCapabilities())
    expect(result.current.taxonomyCreate).toBe(false)
    expect(result.current.deleteEntries).toBe(false)
    act(() => store.setWebCapabilities({ outboxV2: true, monthIndex: false }))
    expect(result.current.taxonomyCreate).toBe(true)
    expect(result.current.deleteEntries).toBe(true)
    act(() => store.setWrites(false))
    expect(result.current.taxonomyCreate).toBe(false)
    expect(result.current.deleteEntries).toBe(false)
    // Rename and delete of journals and tags, and the Trash, stay desktop-only.
    act(() => store.setWrites(true))
    expect(result.current.taxonomyEdits).toBe(false)
    expect(result.current.trash).toBe(false)
  })

  it('web: gallery, lookback, stats, mapView and versionsRead follow the month index', async () => {
    vi.stubEnv('VITE_MEMLORE_PLATFORM', 'web')
    vi.resetModules()
    const { useCapabilities } = await import('./useCapabilities')
    const { useCapabilitiesStore } = await import('../stores/capabilitiesStore')
    const store = useCapabilitiesStore.getState()
    store.setWebCapabilities({ outboxV2: true, monthIndex: false })
    const { result } = renderHook(() => useCapabilities())
    const indexed = ['gallery', 'lookback', 'stats', 'mapView', 'versionsRead'] as const
    for (const flag of indexed) expect(result.current[flag], flag).toBe(false)
    act(() => store.setWebCapabilities({ outboxV2: false, monthIndex: true }))
    for (const flag of indexed) expect(result.current[flag], flag).toBe(true)
    // Version restore and the dashboard are not part of the index.
    expect(result.current.versions).toBe(false)
    // Location and weather writes stay desktop-only: only the map view follows the index.
    expect(result.current.maps).toBe(false)
    expect(result.current.dashboard).toBe(false)
  })
})
