import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { BasemapStatusKind } from '../lib/tauri'
import type { MapTileSource } from './useMapSourceSettings'

const mockSettings = {
  source: null as MapTileSource | null,
  maptilerKey: '',
  isLoading: true,
  mapkitAvailable: false,
}

const mockBasemap = {
  status: 'not_downloaded' as BasemapStatusKind,
  hydrated: false,
}

vi.mock('./useMapSourceSettings', async () => {
  const actual =
    await vi.importActual<typeof import('./useMapSourceSettings')>('./useMapSourceSettings')
  return {
    ...actual,
    useMapSourceSettings: () => mockSettings,
  }
})

vi.mock('./useBasemap', () => ({
  useBasemap: () => mockBasemap,
}))

import { useMapSourceUsable } from './useMapSourceUsable'

beforeEach(() => {
  mockSettings.source = null
  mockSettings.maptilerKey = ''
  mockSettings.isLoading = true
  mockSettings.mapkitAvailable = false
  mockBasemap.status = 'not_downloaded'
  mockBasemap.hydrated = false
})

describe('useMapSourceUsable', () => {
  it('settings still loading → usable false', () => {
    mockSettings.isLoading = true
    mockSettings.source = 'offline'
    mockBasemap.status = 'ready'
    mockBasemap.hydrated = true

    const { result } = renderHook(() => useMapSourceUsable())
    expect(result.current.usable).toBe(false)
    expect(result.current.isLoading).toBe(true)
  })

  it('settings loaded + offline + basemap ready → usable true', () => {
    mockSettings.isLoading = false
    mockSettings.source = 'offline'
    mockBasemap.status = 'ready'
    mockBasemap.hydrated = true

    const { result } = renderHook(() => useMapSourceUsable())
    expect(result.current.usable).toBe(true)
    expect(result.current.isLoading).toBe(false)
  })

  it('settings loaded + offline + not_downloaded → usable false', () => {
    mockSettings.isLoading = false
    mockSettings.source = 'offline'
    mockBasemap.status = 'not_downloaded'
    mockBasemap.hydrated = true

    const { result } = renderHook(() => useMapSourceUsable())
    expect(result.current.usable).toBe(false)
    expect(result.current.isLoading).toBe(false)
  })

  it('offline waits for basemap hydrate before declaring not loading', () => {
    mockSettings.isLoading = false
    mockSettings.source = 'offline'
    mockBasemap.status = 'ready'
    mockBasemap.hydrated = false

    const { result } = renderHook(() => useMapSourceUsable())
    expect(result.current.isLoading).toBe(true)
    expect(result.current.usable).toBe(false)
  })

  it('mapkit + mapkitAvailable → usable true', () => {
    mockSettings.isLoading = false
    mockSettings.source = 'mapkit'
    mockSettings.mapkitAvailable = true
    mockBasemap.hydrated = true

    const { result } = renderHook(() => useMapSourceUsable())
    expect(result.current.usable).toBe(true)
    expect(result.current.isLoading).toBe(false)
  })

  it('mapkit + mapkit unavailable → usable false', () => {
    mockSettings.isLoading = false
    mockSettings.source = 'mapkit'
    mockSettings.mapkitAvailable = false
    mockBasemap.hydrated = true

    const { result } = renderHook(() => useMapSourceUsable())
    expect(result.current.usable).toBe(false)
    expect(result.current.isLoading).toBe(false)
  })
})
