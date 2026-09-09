import { describe, expect, it } from 'vitest'
import { downloadedAssetImpact, type DownloadedAssetImpactSnapshot } from './downloadedAssetImpact'

function snapshot(
  overrides: Partial<DownloadedAssetImpactSnapshot> & Pick<DownloadedAssetImpactSnapshot, 'kind'>,
): DownloadedAssetImpactSnapshot {
  return {
    genProvider: null,
    genChatModel: null,
    embedProvider: null,
    embedModel: null,
    mapSource: null,
    customFontFamily: null,
    ...overrides,
  }
}

describe('downloadedAssetImpact', () => {
  describe('embed_model', () => {
    it('is in use when the on-device embed slot points at this id', () => {
      expect(
        downloadedAssetImpact(
          snapshot({
            kind: 'embed_model',
            id: 'multilingual-e5-base',
            embedProvider: 'on-device',
            embedModel: 'multilingual-e5-base',
          }),
        ),
      ).toEqual({
        inUse: true,
        impactKey: 'data_section.downloads.impact.embed_model',
      })
    })

    it('is not in use when the embed provider is not on-device', () => {
      expect(
        downloadedAssetImpact(
          snapshot({
            kind: 'embed_model',
            id: 'multilingual-e5-base',
            embedProvider: 'openai',
            embedModel: 'multilingual-e5-base',
          }),
        ),
      ).toEqual({
        inUse: false,
        impactKey: 'data_section.downloads.impact.embed_model',
      })
    })

    it('is not in use when a different on-device model is selected', () => {
      expect(
        downloadedAssetImpact(
          snapshot({
            kind: 'embed_model',
            id: 'multilingual-e5-base',
            embedProvider: 'on-device',
            embedModel: 'nomic-embed-text-v1.5',
          }),
        ),
      ).toEqual({
        inUse: false,
        impactKey: 'data_section.downloads.impact.embed_model',
      })
    })

    it('returns the embed impact key even when unused', () => {
      expect(downloadedAssetImpact(snapshot({ kind: 'embed_model' })).impactKey).toBe(
        'data_section.downloads.impact.embed_model',
      )
    })
  })

  describe('llm_model', () => {
    it('is in use when the on-device-llm gen slot points at this id', () => {
      expect(
        downloadedAssetImpact(
          snapshot({
            kind: 'llm_model',
            id: 'gemma-4-e4b-it',
            genProvider: 'on-device-llm',
            genChatModel: 'gemma-4-e4b-it',
          }),
        ),
      ).toEqual({
        inUse: true,
        impactKey: 'data_section.downloads.impact.llm_model',
      })
    })

    it('is not in use when the gen provider is hosted', () => {
      expect(
        downloadedAssetImpact(
          snapshot({
            kind: 'llm_model',
            id: 'gemma-4-e4b-it',
            genProvider: 'openai',
            genChatModel: 'gemma-4-e4b-it',
          }),
        ),
      ).toEqual({
        inUse: false,
        impactKey: 'data_section.downloads.impact.llm_model',
      })
    })

    it('is not in use when a different on-device-llm model is selected', () => {
      expect(
        downloadedAssetImpact(
          snapshot({
            kind: 'llm_model',
            id: 'gemma-4-e4b-it',
            genProvider: 'on-device-llm',
            genChatModel: 'gemma-4-e2b-it',
          }),
        ),
      ).toEqual({
        inUse: false,
        impactKey: 'data_section.downloads.impact.llm_model',
      })
    })
  })

  describe('llm_binary', () => {
    it('is in use whenever the gen provider is on-device-llm', () => {
      expect(
        downloadedAssetImpact(
          snapshot({
            kind: 'llm_binary',
            genProvider: 'on-device-llm',
            genChatModel: 'gemma-4-e4b-it',
          }),
        ),
      ).toEqual({
        inUse: true,
        impactKey: 'data_section.downloads.impact.llm_binary',
      })
    })

    it('is not in use when generation is a hosted provider', () => {
      expect(
        downloadedAssetImpact(
          snapshot({
            kind: 'llm_binary',
            genProvider: 'openai',
            genChatModel: 'gpt-4o-mini',
          }),
        ),
      ).toEqual({
        inUse: false,
        impactKey: 'data_section.downloads.impact.llm_binary',
      })
    })
  })

  describe('basemap', () => {
    it('is in use when the map source is offline', () => {
      expect(downloadedAssetImpact(snapshot({ kind: 'basemap', mapSource: 'offline' }))).toEqual({
        inUse: true,
        impactKey: 'data_section.downloads.impact.basemap',
      })
    })

    it('is not in use for maptiler, mapkit, or an unset source', () => {
      expect(
        downloadedAssetImpact(snapshot({ kind: 'basemap', mapSource: 'maptiler' })).inUse,
      ).toBe(false)
      expect(downloadedAssetImpact(snapshot({ kind: 'basemap', mapSource: 'mapkit' })).inUse).toBe(
        false,
      )
      expect(downloadedAssetImpact(snapshot({ kind: 'basemap' })).inUse).toBe(false)
    })

    it('returns the basemap impact key even when unused', () => {
      expect(downloadedAssetImpact(snapshot({ kind: 'basemap' })).impactKey).toBe(
        'data_section.downloads.impact.basemap',
      )
    })
  })

  describe('fonts', () => {
    it('is in use when a custom font family is set', () => {
      expect(
        downloadedAssetImpact(snapshot({ kind: 'fonts', customFontFamily: 'Fraunces' })),
      ).toEqual({
        inUse: true,
        impactKey: 'data_section.downloads.impact.fonts',
      })
    })

    it('is not in use when customFontFamily is null', () => {
      expect(downloadedAssetImpact(snapshot({ kind: 'fonts' }))).toEqual({
        inUse: false,
        impactKey: 'data_section.downloads.impact.fonts',
      })
    })

    it('treats an empty string as in use (only null is unused)', () => {
      expect(downloadedAssetImpact(snapshot({ kind: 'fonts', customFontFamily: '' })).inUse).toBe(
        true,
      )
    })
  })
})
