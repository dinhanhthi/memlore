import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

vi.mock('../lib/tauri', () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  getMapkitToken: vi.fn(),
}))

import { getMapkitToken, getSetting, setSetting } from '../lib/tauri'
import {
  clearMapTileSource,
  formatBasemapSizeGb,
  isMapSourceUsable,
  MAP_TILE_SOURCES,
  useMapSourceSettings,
} from './useMapSourceSettings'

const mockedGet = vi.mocked(getSetting)
const mockedSet = vi.mocked(setSetting)
const mockedMapkit = vi.mocked(getMapkitToken)

beforeEach(() => {
  vi.resetAllMocks()
  mockedSet.mockResolvedValue(undefined)
  mockedMapkit.mockResolvedValue({ available: false })
})

describe('useMapSourceSettings', () => {
  it('loads_unset_when_settings_empty — nulls and empty string → source=null, empty key', async () => {
    mockedGet
      .mockResolvedValueOnce(null) // map_tile_source
      .mockResolvedValueOnce(null) // maptiler_api_key

    const { result } = renderHook(() => useMapSourceSettings())

    expect(result.current.isLoading).toBe(true)

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.source).toBe(null)
    expect(result.current.maptilerKey).toBe('')
  })

  it('treats_empty_string_source_as_unset', async () => {
    mockedGet.mockResolvedValueOnce('').mockResolvedValueOnce(null)

    const { result } = renderHook(() => useMapSourceSettings())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.source).toBe(null)
  })

  it('loads_persisted_offline_source', async () => {
    mockedGet.mockResolvedValueOnce('offline').mockResolvedValueOnce('')

    const { result } = renderHook(() => useMapSourceSettings())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.source).toBe('offline')
  })

  it('loads_persisted_maptiler_source_and_key', async () => {
    mockedGet.mockResolvedValueOnce('maptiler').mockResolvedValueOnce('mt_live')

    const { result } = renderHook(() => useMapSourceSettings())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.source).toBe('maptiler')
    expect(result.current.maptilerKey).toBe('mt_live')
  })

  it('treats_unknown_source_value_as_unset', async () => {
    mockedGet.mockResolvedValueOnce('osm').mockResolvedValueOnce(null)

    const { result } = renderHook(() => useMapSourceSettings())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.source).toBe(null)
  })

  it('set_source_persists_offline', async () => {
    mockedGet.mockResolvedValueOnce(null).mockResolvedValueOnce(null)

    const { result } = renderHook(() => useMapSourceSettings())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.setSource('offline')
    })

    expect(mockedSet).toHaveBeenCalledWith('map_tile_source', 'offline')
    expect(result.current.source).toBe('offline')
  })

  it('set_source_persists_maptiler', async () => {
    mockedGet.mockResolvedValueOnce(null).mockResolvedValueOnce(null)

    const { result } = renderHook(() => useMapSourceSettings())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.setSource('maptiler')
    })

    expect(mockedSet).toHaveBeenCalledWith('map_tile_source', 'maptiler')
    expect(result.current.source).toBe('maptiler')
  })

  it('set_source_rejects_invalid_value — throws without calling setSetting', async () => {
    mockedGet.mockResolvedValueOnce(null).mockResolvedValueOnce(null)

    const { result } = renderHook(() => useMapSourceSettings())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await expect(
        // @ts-expect-error deliberate invalid input
        result.current.setSource('xyz'),
      ).rejects.toThrow()
    })

    expect(mockedSet).not.toHaveBeenCalled()
  })

  it('set_maptiler_key_persists_and_updates_state', async () => {
    mockedGet.mockResolvedValueOnce(null).mockResolvedValueOnce(null)

    const { result } = renderHook(() => useMapSourceSettings())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.setMaptilerKey('mt_new_key')
    })

    expect(mockedSet).toHaveBeenCalledWith('maptiler_api_key', 'mt_new_key')
    expect(result.current.maptilerKey).toBe('mt_new_key')
  })

  it('set_source_syncs_across_hook_instances', async () => {
    mockedGet.mockResolvedValue(null)

    const a = renderHook(() => useMapSourceSettings())
    const b = renderHook(() => useMapSourceSettings())
    await waitFor(() => expect(a.result.current.isLoading).toBe(false))
    await waitFor(() => expect(b.result.current.isLoading).toBe(false))

    await act(async () => {
      await a.result.current.setSource('offline')
    })

    expect(b.result.current.source).toBe('offline')
  })

  it('set_maptiler_key_syncs_across_hook_instances', async () => {
    mockedGet.mockResolvedValue(null)

    const a = renderHook(() => useMapSourceSettings())
    const b = renderHook(() => useMapSourceSettings())
    await waitFor(() => expect(a.result.current.isLoading).toBe(false))
    await waitFor(() => expect(b.result.current.isLoading).toBe(false))

    await act(async () => {
      await a.result.current.setMaptilerKey('mt_shared')
    })

    expect(b.result.current.maptilerKey).toBe('mt_shared')
  })

  it('set_source_does_not_overwrite_key', async () => {
    mockedGet.mockResolvedValueOnce('maptiler').mockResolvedValueOnce('mt_keep')

    const { result } = renderHook(() => useMapSourceSettings())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.setSource('offline')
    })

    expect(result.current.maptilerKey).toBe('mt_keep')
    expect(result.current.source).toBe('offline')
  })

  it('includes mapkit in MAP_TILE_SOURCES', () => {
    expect(MAP_TILE_SOURCES).toContain('mapkit')
  })

  it('loads_persisted_mapkit_source', async () => {
    mockedGet.mockResolvedValueOnce('mapkit').mockResolvedValueOnce('')

    const { result } = renderHook(() => useMapSourceSettings())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.source).toBe('mapkit')
  })

  it('set_source_persists_mapkit', async () => {
    mockedGet.mockResolvedValueOnce(null).mockResolvedValueOnce(null)

    const { result } = renderHook(() => useMapSourceSettings())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.setSource('mapkit')
    })

    expect(mockedSet).toHaveBeenCalledWith('map_tile_source', 'mapkit')
    expect(result.current.source).toBe('mapkit')
  })

  it('mapkitAvailable is false when getMapkitToken reports unavailable', async () => {
    mockedGet.mockResolvedValue(null)
    mockedMapkit.mockResolvedValue({ available: false })

    const { result } = renderHook(() => useMapSourceSettings())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.mapkitAvailable).toBe(false)
  })

  it('mapkitAvailable is true when getMapkitToken returns a token', async () => {
    mockedGet.mockResolvedValue(null)
    mockedMapkit.mockResolvedValue({ available: true, token: 'jwt.example' })

    const { result } = renderHook(() => useMapSourceSettings())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.mapkitAvailable).toBe(true)
  })

  it('getMapkitToken reject still hydrates source and key', async () => {
    mockedGet.mockResolvedValueOnce('offline').mockResolvedValueOnce('mt_keep')
    mockedMapkit.mockRejectedValue(new Error('db not ready'))

    const { result } = renderHook(() => useMapSourceSettings())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.source).toBe('offline')
    expect(result.current.maptilerKey).toBe('mt_keep')
    expect(result.current.mapkitAvailable).toBe(false)
    expect(result.current.isLoading).toBe(false)
  })

  it('clearMapTileSource writes empty source and preserves maptilerKey', async () => {
    mockedGet.mockResolvedValueOnce('offline').mockResolvedValueOnce('mt_keep')

    const { result } = renderHook(() => useMapSourceSettings())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.source).toBe('offline')
    expect(result.current.maptilerKey).toBe('mt_keep')

    await act(async () => {
      await clearMapTileSource()
    })

    expect(mockedSet).toHaveBeenCalledWith('map_tile_source', '')
    expect(result.current.source).toBe(null)
    expect(result.current.maptilerKey).toBe('mt_keep')
  })
})

describe('isMapSourceUsable', () => {
  it('null source is not usable', () => {
    expect(isMapSourceUsable(null, 'mt_key', 'ready')).toBe(false)
  })

  it('offline + not ready is not usable', () => {
    expect(isMapSourceUsable('offline', '', 'not_downloaded')).toBe(false)
    expect(isMapSourceUsable('offline', '', 'downloading')).toBe(false)
  })

  it('offline + ready is usable', () => {
    expect(isMapSourceUsable('offline', '', 'ready')).toBe(true)
  })

  it('maptiler + empty or whitespace key is not usable', () => {
    expect(isMapSourceUsable('maptiler', '', 'ready')).toBe(false)
    expect(isMapSourceUsable('maptiler', '   ', 'not_downloaded')).toBe(false)
  })

  it('maptiler + key is usable', () => {
    expect(isMapSourceUsable('maptiler', 'mt_live', 'not_downloaded')).toBe(true)
  })

  it('mapkit without token is not usable', () => {
    expect(isMapSourceUsable('mapkit', '', 'not_downloaded')).toBe(false)
    expect(isMapSourceUsable('mapkit', '', 'ready', false)).toBe(false)
  })

  it('mapkit with token is usable regardless of basemap or MapTiler key', () => {
    expect(isMapSourceUsable('mapkit', '', 'not_downloaded', true)).toBe(true)
  })
})

describe('formatBasemapSizeGb', () => {
  it('formats the pinned archive size as decimal GB', () => {
    expect(formatBasemapSizeGb(552_165_687)).toBe('0.55')
  })
})
