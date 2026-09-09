export type DownloadedAssetKind = 'embed_model' | 'llm_model' | 'llm_binary' | 'basemap' | 'fonts'

export type DownloadedAssetImpactSnapshot = {
  kind: DownloadedAssetKind
  /** Required for `embed_model` and `llm_model` in-use checks. */
  id?: string
  genProvider: string | null
  genChatModel: string | null
  embedProvider: string | null
  embedModel: string | null
  mapSource: string | null
  customFontFamily: string | null
}

export type DownloadedAssetImpact = {
  inUse: boolean
  impactKey: string
}

const IMPACT_KEYS: Record<DownloadedAssetKind, string> = {
  embed_model: 'data_section.downloads.impact.embed_model',
  llm_model: 'data_section.downloads.impact.llm_model',
  llm_binary: 'data_section.downloads.impact.llm_binary',
  basemap: 'data_section.downloads.impact.basemap',
  fonts: 'data_section.downloads.impact.fonts',
}

function isInUse(snapshot: DownloadedAssetImpactSnapshot): boolean {
  switch (snapshot.kind) {
    case 'embed_model':
      return snapshot.embedProvider === 'on-device' && snapshot.embedModel === snapshot.id
    case 'llm_model':
      return snapshot.genProvider === 'on-device-llm' && snapshot.genChatModel === snapshot.id
    case 'llm_binary':
      return snapshot.genProvider === 'on-device-llm'
    case 'basemap':
      return snapshot.mapSource === 'offline'
    case 'fonts':
      return snapshot.customFontFamily !== null
  }
}

/** Whether a downloaded asset is the active setting, plus the i18n key for confirm copy. */
export function downloadedAssetImpact(
  snapshot: DownloadedAssetImpactSnapshot,
): DownloadedAssetImpact {
  return {
    inUse: isInUse(snapshot),
    impactKey: IMPACT_KEYS[snapshot.kind],
  }
}
