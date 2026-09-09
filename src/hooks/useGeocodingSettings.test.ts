import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

vi.mock('../lib/tauri', () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}))

import { getSetting, setSetting } from '../lib/tauri'
import { useGeocodingSettings } from './useGeocodingSettings'

const mockedGet = vi.mocked(getSetting)
const mockedSet = vi.mocked(setSetting)

beforeEach(() => {
  vi.resetAllMocks()
  mockedSet.mockResolvedValue(undefined)
})

describe('useGeocodingSettings', () => {
  it('loads_defaults_when_settings_empty — all nulls → photon, empty keys, isLoading=false', async () => {
    mockedGet
      .mockResolvedValueOnce(null) // geocoding_provider
      .mockResolvedValueOnce(null) // mapbox_api_key
      .mockResolvedValueOnce(null) // google_api_key

    const { result } = renderHook(() => useGeocodingSettings())

    // Should start loading
    expect(result.current.isLoading).toBe(true)

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.provider).toBe('photon')
    expect(result.current.mapboxKey).toBe('')
    expect(result.current.googleKey).toBe('')
  })

  it('loads_persisted_values_on_mount — stored values flow into state', async () => {
    mockedGet
      .mockResolvedValueOnce('mapbox') // geocoding_provider
      .mockResolvedValueOnce('tok123') // mapbox_api_key
      .mockResolvedValueOnce('gKey') // google_api_key

    const { result } = renderHook(() => useGeocodingSettings())

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.provider).toBe('mapbox')
    expect(result.current.mapboxKey).toBe('tok123')
    expect(result.current.googleKey).toBe('gKey')
  })

  it('treats_unknown_provider_value_as_photon', async () => {
    mockedGet
      .mockResolvedValueOnce('foo') // unknown provider
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)

    const { result } = renderHook(() => useGeocodingSettings())

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.provider).toBe('photon')
  })

  it('set_provider_persists_and_updates_state', async () => {
    mockedGet.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(null)

    const { result } = renderHook(() => useGeocodingSettings())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.setProvider('mapbox')
    })

    expect(mockedSet).toHaveBeenCalledWith('geocoding_provider', 'mapbox')
    expect(result.current.provider).toBe('mapbox')
  })

  it('set_provider_rejects_invalid_value — throws without calling setSetting', async () => {
    mockedGet.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(null)

    const { result } = renderHook(() => useGeocodingSettings())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await expect(
        // @ts-expect-error deliberate invalid input
        result.current.setProvider('xyz'),
      ).rejects.toThrow()
    })

    expect(mockedSet).not.toHaveBeenCalled()
  })

  it('set_mapbox_key_persists_and_updates_state', async () => {
    mockedGet.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(null)

    const { result } = renderHook(() => useGeocodingSettings())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.setMapboxKey('pk.eyJnew')
    })

    expect(mockedSet).toHaveBeenCalledWith('mapbox_api_key', 'pk.eyJnew')
    expect(result.current.mapboxKey).toBe('pk.eyJnew')
  })

  it('set_google_key_persists_and_updates_state', async () => {
    mockedGet.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(null)

    const { result } = renderHook(() => useGeocodingSettings())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.setGoogleKey('AIzaSyNew')
    })

    expect(mockedSet).toHaveBeenCalledWith('google_api_key', 'AIzaSyNew')
    expect(result.current.googleKey).toBe('AIzaSyNew')
  })

  it('set_provider_persists_maptiler', async () => {
    mockedGet.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(null)

    const { result } = renderHook(() => useGeocodingSettings())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.setProvider('maptiler')
    })

    expect(mockedSet).toHaveBeenCalledWith('geocoding_provider', 'maptiler')
    expect(result.current.provider).toBe('maptiler')
  })

  it('loads_persisted_maptiler_provider', async () => {
    mockedGet
      .mockResolvedValueOnce('maptiler')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)

    const { result } = renderHook(() => useGeocodingSettings())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.provider).toBe('maptiler')
  })

  it('set_provider_does_not_overwrite_keys', async () => {
    mockedGet
      .mockResolvedValueOnce('mapbox')
      .mockResolvedValueOnce('tok123')
      .mockResolvedValueOnce('gKey99')

    const { result } = renderHook(() => useGeocodingSettings())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.setProvider('google')
    })

    // Keys must be untouched after switching provider
    expect(result.current.mapboxKey).toBe('tok123')
    expect(result.current.googleKey).toBe('gKey99')
    expect(result.current.provider).toBe('google')
  })
})
