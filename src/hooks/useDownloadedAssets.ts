import { useCallback, useEffect, useMemo, useState } from 'react'
import { downloadedAssetImpact, type DownloadedAssetKind } from '../lib/downloadedAssetImpact'
import { navigateToSetting } from '../lib/settingsNavigation'
import {
  BASEMAP_SIZE_BYTES,
  clearFontCache,
  getFontCacheStats,
  onDeviceLlmBinaryStatus,
  type FontCacheStats,
} from '../lib/tauri'
import { useAIProviderConfig } from './useAIProviderConfig'
import { useBasemap } from './useBasemap'
import { useMapSourceSettings } from './useMapSourceSettings'
import { useOnDeviceModels } from './useOnDeviceModels'
import { BINARY_PHASE_ID, useOnDeviceLlmModels } from './useOnDeviceLlmModels'
import { useThemeCustomization } from './useThemeCustomization'

export type { DownloadedAssetKind }

export interface DownloadedAsset {
  id: string
  kind: DownloadedAssetKind
  title: string
  sizeBytes: number
  inUse: boolean
  impactKey: string
  openSetting: () => void
  remove: () => Promise<void>
}

export interface UseDownloadedAssetsReturn {
  assets: DownloadedAsset[]
}

function openForKind(kind: DownloadedAssetKind): () => void {
  switch (kind) {
    case 'embed_model':
    case 'llm_model':
    case 'llm_binary':
      return () => navigateToSetting('ai', { aiTab: 'chat' })
    case 'basemap':
      return () => navigateToSetting('location', { locationTab: 'geocoding' })
    case 'fonts':
      return () => navigateToSetting('editor', { editorTab: 'font' })
  }
}

export function useDownloadedAssets(): UseDownloadedAssetsReturn {
  const embed = useOnDeviceModels()
  const llm = useOnDeviceLlmModels()
  const basemap = useBasemap()
  const { source: mapSource } = useMapSourceSettings()
  const { providers, forgetGeneration, forgetEmbedding } = useAIProviderConfig()
  const { customGoogleFontFamily, resetCustomFont } = useThemeCustomization()

  const [fontStats, setFontStats] = useState<FontCacheStats | null>(null)
  const [binarySizeBytes, setBinarySizeBytes] = useState(0)

  const refreshFontStats = useCallback(async () => {
    try {
      setFontStats(await getFontCacheStats())
    } catch (e) {
      console.warn('useDownloadedAssets: getFontCacheStats failed', e)
    }
  }, [])

  const refreshBinarySize = useCallback(async () => {
    try {
      const status = await onDeviceLlmBinaryStatus()
      setBinarySizeBytes(status.size_bytes)
    } catch (e) {
      console.warn('useDownloadedAssets: onDeviceLlmBinaryStatus failed', e)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const stats = await getFontCacheStats()
        if (!cancelled) setFontStats(stats)
      } catch (e) {
        console.warn('useDownloadedAssets: getFontCacheStats failed', e)
      }
    })()
    void (async () => {
      try {
        const status = await onDeviceLlmBinaryStatus()
        if (!cancelled) setBinarySizeBytes(status.size_bytes)
      } catch (e) {
        console.warn('useDownloadedAssets: onDeviceLlmBinaryStatus failed', e)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const genProvider = providers?.generation?.provider ?? null
  const genChatModel = providers?.generation?.chatModel ?? null
  const embedProvider = providers?.embedding?.provider ?? null
  const embedModel = providers?.embedding?.embeddingModel ?? null

  const assets = useMemo(() => {
    const rows: DownloadedAsset[] = []
    const snapshot = {
      genProvider,
      genChatModel,
      embedProvider,
      embedModel,
      mapSource,
      customFontFamily: customGoogleFontFamily,
    }

    for (const entry of embed.catalog) {
      if (embed.states[entry.id]?.status !== 'ready') continue
      const kind = 'embed_model' as const
      const { inUse, impactKey } = downloadedAssetImpact({ ...snapshot, kind, id: entry.id })
      rows.push({
        id: entry.id,
        kind,
        title: entry.displayName,
        sizeBytes: entry.downloadSizeBytes,
        inUse,
        impactKey,
        openSetting: openForKind(kind),
        remove: async () => {
          if (inUse) await forgetEmbedding()
          await embed.remove(entry.id)
        },
      })
    }

    for (const entry of llm.catalog) {
      if (llm.states[entry.id]?.status !== 'ready') continue
      const kind = 'llm_model' as const
      const { inUse, impactKey } = downloadedAssetImpact({ ...snapshot, kind, id: entry.id })
      rows.push({
        id: entry.id,
        kind,
        title: entry.display_name,
        sizeBytes: entry.download_size_bytes,
        inUse,
        impactKey,
        openSetting: openForKind(kind),
        remove: async () => {
          if (inUse) await forgetGeneration()
          await llm.remove(entry.id)
        },
      })
    }

    if (llm.binaryState.status === 'ready') {
      const kind = 'llm_binary' as const
      const { inUse, impactKey } = downloadedAssetImpact({ ...snapshot, kind })
      rows.push({
        id: BINARY_PHASE_ID,
        kind,
        title: 'llama-server',
        sizeBytes: binarySizeBytes,
        inUse,
        impactKey,
        openSetting: openForKind(kind),
        remove: async () => {
          if (inUse) await forgetGeneration()
          await llm.removeBinary()
          await refreshBinarySize()
        },
      })
    }

    if (basemap.status === 'ready') {
      const kind = 'basemap' as const
      const { inUse, impactKey } = downloadedAssetImpact({ ...snapshot, kind })
      rows.push({
        id: 'basemap',
        kind,
        title: 'Offline map',
        sizeBytes: basemap.size_bytes ?? BASEMAP_SIZE_BYTES,
        inUse,
        impactKey,
        openSetting: openForKind(kind),
        remove: async () => {
          await basemap.delete()
        },
      })
    }

    const showFonts =
      (fontStats != null && fontStats.fontCount > 0) || customGoogleFontFamily !== null
    if (showFonts) {
      const kind = 'fonts' as const
      const { inUse, impactKey } = downloadedAssetImpact({ ...snapshot, kind })
      rows.push({
        id: 'fonts',
        kind,
        title: 'Custom fonts',
        sizeBytes: fontStats?.usedBytes ?? 0,
        inUse,
        impactKey,
        openSetting: openForKind(kind),
        remove: async () => {
          await clearFontCache()
          if (customGoogleFontFamily !== null) await resetCustomFont()
          await refreshFontStats()
        },
      })
    }

    return rows
  }, [
    embed,
    llm,
    basemap,
    genProvider,
    genChatModel,
    embedProvider,
    embedModel,
    mapSource,
    customGoogleFontFamily,
    fontStats,
    binarySizeBytes,
    forgetGeneration,
    forgetEmbedding,
    resetCustomFont,
    refreshFontStats,
    refreshBinarySize,
  ])

  return { assets }
}
