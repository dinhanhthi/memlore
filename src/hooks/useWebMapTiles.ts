import { useCallback } from 'react'
import { setSetting } from '../lib/tauri'
import { clearMapTileSource, publishMapSource, useMapSourceSettings } from './useMapSourceSettings'

export interface WebMapTiles {
  isLoading: boolean
  /** A MapTiler key is stored, so turning tiles on needs no key prompt. */
  hasKey: boolean
  /** Records consent, stores `key` (or reuses the stored one), selects MapTiler.
   *  Rejects without writing anything when no key is given or stored. */
  enable: (key?: string) => Promise<void>
  /** Revokes consent; every map hook drops back to no source. The key stays stored. */
  disable: () => Promise<void>
  /** Turns tiles off and deletes the stored key (`''` deletes the setting). */
  removeKey: () => Promise<void>
}

/**
 * Web map tiles consent. Tiles reveal the viewed area and the IP address to
 * MapTiler, so the web asks first and only uses the user's own key. The web
 * backend reads `map_tile_source` as unset unless `web_map_tiles_consent` is
 * `'1'`, so consent is written first.
 */
export function useWebMapTiles(): WebMapTiles {
  const { maptilerKey, isLoading } = useMapSourceSettings()

  const enable = useCallback(
    async (key?: string) => {
      const next = key?.trim() || maptilerKey.trim()
      if (next === '') throw new Error('A MapTiler key is required')
      // Consent goes first and is safe even if the key write below fails: the
      // backend reads `map_tile_source` as unset until consent is '1', and the
      // source is written last, so a failed key write cannot turn tiles on.
      await setSetting('web_map_tiles_consent', '1')
      if (next !== maptilerKey) await setSetting('maptiler_api_key', next)
      await setSetting('map_tile_source', 'maptiler')
      publishMapSource({ source: 'maptiler', maptilerKey: next })
    },
    [maptilerKey],
  )

  const disable = useCallback(async () => {
    await setSetting('web_map_tiles_consent', '0')
    await clearMapTileSource()
  }, [])

  const removeKey = useCallback(async () => {
    // Tiles off before the key goes, so nothing renders with a missing key.
    await setSetting('web_map_tiles_consent', '0')
    await setSetting('map_tile_source', '')
    await setSetting('maptiler_api_key', '')
    publishMapSource({ source: null, maptilerKey: '' })
  }, [])

  return { isLoading, hasKey: maptilerKey.trim() !== '', enable, disable, removeKey }
}
