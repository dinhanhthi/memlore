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
})
