import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

vi.mock('../lib/tauri', () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  getMapkitToken: vi.fn(),
}))

import { getMapkitToken, getSetting, setSetting } from '../lib/tauri'
import { useMapSourceSettings } from './useMapSourceSettings'
import { useWebMapTiles } from './useWebMapTiles'

const mockedGet = vi.mocked(getSetting)
const mockedSet = vi.mocked(setSetting)

function stored(source: string | null, key: string | null) {
  mockedGet.mockImplementation(async (name: string) =>
    name === 'map_tile_source' ? source : name === 'maptiler_api_key' ? key : null,
  )
}

async function mount() {
  const hook = renderHook(() => ({ tiles: useWebMapTiles(), settings: useMapSourceSettings() }))
  await waitFor(() => expect(hook.result.current.tiles.isLoading).toBe(false))
  return hook
}

beforeEach(() => {
  vi.resetAllMocks()
  mockedSet.mockResolvedValue(undefined)
  vi.mocked(getMapkitToken).mockResolvedValue({ available: false })
})

describe('useWebMapTiles', () => {
  it('reports whether a MapTiler key is already stored', async () => {
    stored(null, 'mt_saved')
    const { result } = await mount()
    expect(result.current.tiles.hasKey).toBe(true)
  })

  it('enable(key) stores consent first, then the trimmed key, then the source', async () => {
    stored(null, null)
    const { result } = await mount()
    expect(result.current.tiles.hasKey).toBe(false)

    await act(async () => {
      await result.current.tiles.enable('  mt_new  ')
    })

    expect(mockedSet.mock.calls).toEqual([
      ['web_map_tiles_consent', '1'],
      ['maptiler_api_key', 'mt_new'],
      ['map_tile_source', 'maptiler'],
    ])
    // Other mounted map hooks pick up the new source and key right away.
    expect(result.current.settings.source).toBe('maptiler')
    expect(result.current.settings.maptilerKey).toBe('mt_new')
  })

  it('enable() reuses the stored key without rewriting it', async () => {
    stored(null, 'mt_saved')
    const { result } = await mount()

    await act(async () => {
      await result.current.tiles.enable()
    })

    expect(mockedSet.mock.calls).toEqual([
      ['web_map_tiles_consent', '1'],
      ['map_tile_source', 'maptiler'],
    ])
    expect(result.current.settings.source).toBe('maptiler')
  })

  it('enable(newKey) replaces a stored key', async () => {
    stored(null, 'mt_old')
    const { result } = await mount()

    await act(async () => {
      await result.current.tiles.enable('mt_new')
    })

    expect(mockedSet.mock.calls).toEqual([
      ['web_map_tiles_consent', '1'],
      ['maptiler_api_key', 'mt_new'],
      ['map_tile_source', 'maptiler'],
    ])
    expect(result.current.settings.maptilerKey).toBe('mt_new')
  })

  it('removeKey() turns tiles off, then deletes the stored key everywhere', async () => {
    stored('maptiler', 'mt_saved')
    const { result } = await mount()
    expect(result.current.tiles.hasKey).toBe(true)

    await act(async () => {
      await result.current.tiles.removeKey()
    })

    expect(mockedSet.mock.calls).toEqual([
      ['web_map_tiles_consent', '0'],
      ['map_tile_source', ''],
      ['maptiler_api_key', ''],
    ])
    expect(result.current.tiles.hasKey).toBe(false)
    expect(result.current.settings.source).toBe(null)
    expect(result.current.settings.maptilerKey).toBe('')
  })

  it('enable() without any key rejects and writes nothing', async () => {
    stored(null, null)
    const { result } = await mount()

    await expect(result.current.tiles.enable('   ')).rejects.toThrow()
    expect(mockedSet).not.toHaveBeenCalled()
  })

  it('disable() revokes consent and returns every mounted hook to no source', async () => {
    stored('maptiler', 'mt_saved')
    const { result } = await mount()
    expect(result.current.settings.source).toBe('maptiler')

    await act(async () => {
      await result.current.tiles.disable()
    })

    expect(mockedSet).toHaveBeenCalledWith('web_map_tiles_consent', '0')
    expect(result.current.settings.source).toBe(null)
  })
})
