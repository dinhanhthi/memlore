import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BasemapStatusKind } from '../lib/tauri'
import { BASEMAP_SIZE_BYTES } from '../lib/tauri'
import type { AIEmbedProviderConfig, AIGenProviderConfig } from '../types/ai'
import type { MapTileSource } from './useMapSourceSettings'
import {
  BINARY_PHASE_ID,
  type LlmModelState,
  type OnDeviceLlmCatalogEntry,
} from './useOnDeviceLlmModels'
import type { ModelDownloadState } from './useOnDeviceModels'

const mockEmbedRemove = vi.fn()
const mockLlmRemove = vi.fn()
const mockLlmRemoveBinary = vi.fn()
const mockBasemapDelete = vi.fn()
const mockForgetGeneration = vi.fn()
const mockForgetEmbedding = vi.fn()
const mockResetCustomFont = vi.fn()

type EmbedCatalogEntry = {
  id: string
  displayName: string
  downloadSizeBytes: number
}

const mockEmbed = {
  catalog: [] as EmbedCatalogEntry[],
  states: {} as Record<string, ModelDownloadState>,
  remove: mockEmbedRemove,
}

const mockLlm = {
  catalog: [] as OnDeviceLlmCatalogEntry[],
  states: {} as Record<string, LlmModelState>,
  binaryState: { status: 'not_downloaded' } as LlmModelState,
  remove: mockLlmRemove,
  removeBinary: mockLlmRemoveBinary,
}

const mockBasemap = {
  status: 'not_downloaded' as BasemapStatusKind,
  size_bytes: null as number | null,
  delete: mockBasemapDelete,
}

const mockMapSource = {
  source: null as MapTileSource | null,
}

const mockAi = {
  providers: {
    generation: null as AIGenProviderConfig | null,
    image: null,
    embedding: null as AIEmbedProviderConfig | null,
  },
  forgetGeneration: mockForgetGeneration,
  forgetEmbedding: mockForgetEmbedding,
}

const mockTheme = {
  customGoogleFontFamily: null as string | null,
  resetCustomFont: mockResetCustomFont,
}

vi.mock('./useOnDeviceModels', () => ({
  useOnDeviceModels: () => mockEmbed,
}))

vi.mock('./useOnDeviceLlmModels', async () => {
  const actual =
    await vi.importActual<typeof import('./useOnDeviceLlmModels')>('./useOnDeviceLlmModels')
  return {
    ...actual,
    useOnDeviceLlmModels: () => mockLlm,
  }
})

vi.mock('./useBasemap', () => ({
  useBasemap: () => mockBasemap,
}))

vi.mock('./useMapSourceSettings', async () => {
  const actual =
    await vi.importActual<typeof import('./useMapSourceSettings')>('./useMapSourceSettings')
  return {
    ...actual,
    useMapSourceSettings: () => mockMapSource,
  }
})

vi.mock('./useAIProviderConfig', () => ({
  useAIProviderConfig: () => mockAi,
}))

vi.mock('./useThemeCustomization', () => ({
  useThemeCustomization: () => mockTheme,
}))

vi.mock('../lib/settingsNavigation', () => ({
  navigateToSetting: vi.fn(),
}))

vi.mock('../lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('../lib/tauri')>('../lib/tauri')
  return {
    ...actual,
    getFontCacheStats: vi.fn(),
    clearFontCache: vi.fn(),
    onDeviceLlmBinaryStatus: vi.fn(),
  }
})

import * as tauri from '../lib/tauri'
import { navigateToSetting } from '../lib/settingsNavigation'
import { useDownloadedAssets, type DownloadedAsset } from './useDownloadedAssets'

function embedEntry(id: string, downloadSizeBytes: number, displayName = id): EmbedCatalogEntry {
  return { id, displayName, downloadSizeBytes }
}

function llmEntry(
  id: string,
  download_size_bytes: number,
  display_name = id,
): OnDeviceLlmCatalogEntry {
  return {
    id,
    display_name,
    download_size_bytes,
    context_tokens: 8192,
    min_ram_gb: 8,
    recommended: false,
    multilingual: true,
    when_to_choose: '',
    terms_url: '',
    requires_acceptance: false,
  }
}

function genSlot(provider: string, chatModel: string): AIGenProviderConfig {
  return {
    provider,
    endpoint: '',
    endpointClass: 'local',
    chatModel,
    hasApiKey: false,
  }
}

function embedSlot(provider: string, embeddingModel: string): AIEmbedProviderConfig {
  return {
    provider,
    endpoint: '',
    endpointClass: 'local',
    embeddingModel,
    hasApiKey: false,
  }
}

function resetMocks() {
  mockEmbed.catalog = []
  mockEmbed.states = {}
  mockLlm.catalog = []
  mockLlm.states = {}
  mockLlm.binaryState = { status: 'not_downloaded' }
  mockBasemap.status = 'not_downloaded'
  mockBasemap.size_bytes = null
  mockMapSource.source = null
  mockAi.providers.generation = null
  mockAi.providers.embedding = null
  mockTheme.customGoogleFontFamily = null
  mockEmbedRemove.mockReset()
  mockLlmRemove.mockReset()
  mockLlmRemoveBinary.mockReset()
  mockBasemapDelete.mockReset()
  mockForgetGeneration.mockReset()
  mockForgetEmbedding.mockReset()
  mockResetCustomFont.mockReset()
  mockEmbedRemove.mockResolvedValue(undefined)
  mockLlmRemove.mockResolvedValue(undefined)
  mockLlmRemoveBinary.mockResolvedValue(undefined)
  mockBasemapDelete.mockResolvedValue(undefined)
  mockForgetGeneration.mockResolvedValue(undefined)
  mockForgetEmbedding.mockResolvedValue(undefined)
  mockResetCustomFont.mockResolvedValue(undefined)
  vi.mocked(tauri.getFontCacheStats).mockReset()
  vi.mocked(tauri.clearFontCache).mockReset()
  vi.mocked(tauri.onDeviceLlmBinaryStatus).mockReset()
  vi.mocked(tauri.getFontCacheStats).mockResolvedValue({ usedBytes: 0, fontCount: 0 })
  vi.mocked(tauri.clearFontCache).mockResolvedValue({ usedBytes: 0, fontCount: 0 })
  vi.mocked(tauri.onDeviceLlmBinaryStatus).mockResolvedValue({
    installed: false,
    size_bytes: 0,
  })
  vi.mocked(navigateToSetting).mockReset()
}

beforeEach(() => {
  resetMocks()
})

async function renderAssets() {
  const hook = renderHook(() => useDownloadedAssets())
  await waitFor(() => {
    expect(tauri.getFontCacheStats).toHaveBeenCalled()
  })
  return hook
}

function findById(assets: DownloadedAsset[], id: string): DownloadedAsset {
  const row = assets.find((a) => a.id === id)
  if (!row) throw new Error(`missing asset ${id}`)
  return row
}

describe('useDownloadedAssets', () => {
  it('returns an empty list when nothing is ready', async () => {
    const { result } = await renderAssets()
    expect(result.current.assets).toEqual([])
  })

  it('lists only ready embed and llm catalog rows', async () => {
    mockEmbed.catalog = [
      embedEntry('multilingual-e5-base', 1_150_000_000),
      embedEntry('multilingual-e5-small', 470_000_000),
      embedEntry('nomic-embed-text-v1.5', 275_000_000),
    ]
    mockEmbed.states = {
      'multilingual-e5-base': { status: 'ready' },
      'multilingual-e5-small': { status: 'downloading', progress: 40 },
      'nomic-embed-text-v1.5': { status: 'error', errorKey: 'boom' },
    }
    mockLlm.catalog = [
      llmEntry('gemma-4-e4b-it', 5_154_941_280, 'Gemma 4 E4B'),
      llmEntry('qwen-4-1.7b', 1_000_000_000),
    ]
    mockLlm.states = {
      'gemma-4-e4b-it': { status: 'ready' },
      'qwen-4-1.7b': { status: 'error', code: 'fail' },
    }

    const { result } = await renderAssets()
    expect(result.current.assets.map((a) => a.id)).toEqual([
      'multilingual-e5-base',
      'gemma-4-e4b-it',
    ])
    expect(findById(result.current.assets, 'multilingual-e5-base')).toMatchObject({
      kind: 'embed_model',
      title: 'multilingual-e5-base',
      sizeBytes: 1_150_000_000,
    })
    expect(findById(result.current.assets, 'gemma-4-e4b-it')).toMatchObject({
      kind: 'llm_model',
      title: 'Gemma 4 E4B',
      sizeBytes: 5_154_941_280,
    })
  })

  it('lists a ready llama-server binary with size from onDeviceLlmBinaryStatus', async () => {
    mockLlm.binaryState = { status: 'ready' }
    vi.mocked(tauri.onDeviceLlmBinaryStatus).mockResolvedValue({
      installed: true,
      size_bytes: 42_000_000,
    })

    const { result } = await renderAssets()
    await waitFor(() => {
      expect(findById(result.current.assets, BINARY_PHASE_ID).sizeBytes).toBe(42_000_000)
    })
    expect(findById(result.current.assets, BINARY_PHASE_ID)).toMatchObject({
      kind: 'llm_binary',
      title: 'llama-server',
      sizeBytes: 42_000_000,
    })
  })

  it('lists a ready basemap using size_bytes with BASEMAP_SIZE_BYTES fallback', async () => {
    mockBasemap.status = 'ready'
    mockBasemap.size_bytes = null

    const { result } = await renderAssets()
    expect(findById(result.current.assets, 'basemap')).toMatchObject({
      kind: 'basemap',
      sizeBytes: BASEMAP_SIZE_BYTES,
    })
  })

  it('lists fonts when the cache has files', async () => {
    vi.mocked(tauri.getFontCacheStats).mockResolvedValue({ usedBytes: 2048, fontCount: 2 })

    const { result } = await renderAssets()
    await waitFor(() => {
      expect(result.current.assets.some((a) => a.kind === 'fonts')).toBe(true)
    })
    expect(findById(result.current.assets, 'fonts')).toMatchObject({
      kind: 'fonts',
      sizeBytes: 2048,
      inUse: false,
    })
  })

  it('lists fonts when a custom family is set even if the cache is empty', async () => {
    mockTheme.customGoogleFontFamily = 'Fraunces'
    vi.mocked(tauri.getFontCacheStats).mockResolvedValue({ usedBytes: 0, fontCount: 0 })

    const { result } = await renderAssets()
    expect(findById(result.current.assets, 'fonts')).toMatchObject({
      kind: 'fonts',
      inUse: true,
      impactKey: 'data_section.downloads.impact.fonts',
    })
  })

  it('idle embed remove deletes without calling forgetEmbedding', async () => {
    mockEmbed.catalog = [embedEntry('multilingual-e5-base', 1_150_000_000)]
    mockEmbed.states = { 'multilingual-e5-base': { status: 'ready' } }
    mockAi.providers.embedding = embedSlot('openai', 'text-embedding-3-small')

    const { result } = await renderAssets()
    await act(async () => {
      await findById(result.current.assets, 'multilingual-e5-base').remove()
    })

    expect(mockForgetEmbedding).not.toHaveBeenCalled()
    expect(mockForgetGeneration).not.toHaveBeenCalled()
    expect(mockEmbedRemove).toHaveBeenCalledTimes(1)
    expect(mockEmbedRemove).toHaveBeenCalledWith('multilingual-e5-base')
  })

  it('idle llm remove deletes without calling forgetGeneration', async () => {
    mockLlm.catalog = [llmEntry('gemma-4-e4b-it', 5_154_941_280)]
    mockLlm.states = { 'gemma-4-e4b-it': { status: 'ready' } }
    mockAi.providers.generation = genSlot('openai', 'gpt-4o-mini')

    const { result } = await renderAssets()
    await act(async () => {
      await findById(result.current.assets, 'gemma-4-e4b-it').remove()
    })

    expect(mockForgetGeneration).not.toHaveBeenCalled()
    expect(mockLlmRemove).toHaveBeenCalledWith('gemma-4-e4b-it')
  })

  it('in-use llm remove calls forgetGeneration then delete', async () => {
    const order: string[] = []
    mockForgetGeneration.mockImplementation(async () => {
      order.push('forget')
    })
    mockLlmRemove.mockImplementation(async () => {
      order.push('remove')
    })
    mockLlm.catalog = [llmEntry('gemma-4-e4b-it', 5_154_941_280)]
    mockLlm.states = { 'gemma-4-e4b-it': { status: 'ready' } }
    mockAi.providers.generation = genSlot('on-device-llm', 'gemma-4-e4b-it')

    const { result } = await renderAssets()
    expect(findById(result.current.assets, 'gemma-4-e4b-it').inUse).toBe(true)

    await act(async () => {
      await findById(result.current.assets, 'gemma-4-e4b-it').remove()
    })

    expect(order).toEqual(['forget', 'remove'])
    expect(mockForgetGeneration).toHaveBeenCalledTimes(1)
    expect(mockLlmRemove).toHaveBeenCalledWith('gemma-4-e4b-it')
  })

  it('in-use embed remove calls forgetEmbedding then delete', async () => {
    const order: string[] = []
    mockForgetEmbedding.mockImplementation(async () => {
      order.push('forget')
    })
    mockEmbedRemove.mockImplementation(async () => {
      order.push('remove')
    })
    mockEmbed.catalog = [embedEntry('multilingual-e5-base', 1_150_000_000)]
    mockEmbed.states = { 'multilingual-e5-base': { status: 'ready' } }
    mockAi.providers.embedding = embedSlot('on-device', 'multilingual-e5-base')

    const { result } = await renderAssets()
    expect(findById(result.current.assets, 'multilingual-e5-base').inUse).toBe(true)

    await act(async () => {
      await findById(result.current.assets, 'multilingual-e5-base').remove()
    })

    expect(order).toEqual(['forget', 'remove'])
    expect(mockForgetEmbedding).toHaveBeenCalledTimes(1)
    expect(mockEmbedRemove).toHaveBeenCalledWith('multilingual-e5-base')
  })

  it('in-use embed remove does not swallow delete rejection after forgetEmbedding', async () => {
    mockEmbedRemove.mockRejectedValue('disk_error')
    mockEmbed.catalog = [embedEntry('multilingual-e5-base', 1_150_000_000)]
    mockEmbed.states = { 'multilingual-e5-base': { status: 'ready' } }
    mockAi.providers.embedding = embedSlot('on-device', 'multilingual-e5-base')

    const { result } = await renderAssets()
    await expect(findById(result.current.assets, 'multilingual-e5-base').remove()).rejects.toBe(
      'disk_error',
    )
    expect(mockForgetEmbedding).toHaveBeenCalledTimes(1)
    expect(mockEmbedRemove).toHaveBeenCalledWith('multilingual-e5-base')
  })

  it('in-use binary remove calls forgetGeneration then removeBinary', async () => {
    const order: string[] = []
    mockForgetGeneration.mockImplementation(async () => {
      order.push('forget')
    })
    mockLlmRemoveBinary.mockImplementation(async () => {
      order.push('removeBinary')
    })
    mockLlm.binaryState = { status: 'ready' }
    mockAi.providers.generation = genSlot('on-device-llm', 'gemma-4-e4b-it')
    vi.mocked(tauri.onDeviceLlmBinaryStatus).mockResolvedValue({
      installed: true,
      size_bytes: 10,
    })

    const { result } = await renderAssets()
    await waitFor(() => {
      expect(result.current.assets.some((a) => a.kind === 'llm_binary')).toBe(true)
    })
    expect(findById(result.current.assets, BINARY_PHASE_ID).inUse).toBe(true)

    await act(async () => {
      await findById(result.current.assets, BINARY_PHASE_ID).remove()
    })

    expect(order).toEqual(['forget', 'removeBinary'])
  })

  it('idle binary remove does not call forgetGeneration', async () => {
    mockLlm.binaryState = { status: 'ready' }
    mockAi.providers.generation = genSlot('openai', 'gpt-4o-mini')
    vi.mocked(tauri.onDeviceLlmBinaryStatus).mockResolvedValue({
      installed: true,
      size_bytes: 10,
    })

    const { result } = await renderAssets()
    await waitFor(() => {
      expect(result.current.assets.some((a) => a.kind === 'llm_binary')).toBe(true)
    })

    await act(async () => {
      await findById(result.current.assets, BINARY_PHASE_ID).remove()
    })

    expect(mockForgetGeneration).not.toHaveBeenCalled()
    expect(mockLlmRemoveBinary).toHaveBeenCalledTimes(1)
  })

  it('basemap remove calls delete only', async () => {
    mockBasemap.status = 'ready'
    mockMapSource.source = 'offline'

    const { result } = await renderAssets()
    await act(async () => {
      await findById(result.current.assets, 'basemap').remove()
    })

    expect(mockBasemapDelete).toHaveBeenCalledTimes(1)
    expect(mockForgetGeneration).not.toHaveBeenCalled()
    expect(mockForgetEmbedding).not.toHaveBeenCalled()
  })

  it('fonts remove clears the cache and resets a custom family', async () => {
    mockTheme.customGoogleFontFamily = 'Fraunces'
    vi.mocked(tauri.getFontCacheStats).mockResolvedValue({ usedBytes: 100, fontCount: 1 })

    const { result } = await renderAssets()
    await waitFor(() => {
      expect(result.current.assets.some((a) => a.kind === 'fonts')).toBe(true)
    })

    await act(async () => {
      await findById(result.current.assets, 'fonts').remove()
    })

    expect(tauri.clearFontCache).toHaveBeenCalledTimes(1)
    expect(mockResetCustomFont).toHaveBeenCalledTimes(1)
  })

  it('fonts remove skips resetCustomFont when no custom family is set', async () => {
    vi.mocked(tauri.getFontCacheStats).mockResolvedValue({ usedBytes: 100, fontCount: 1 })

    const { result } = await renderAssets()
    await waitFor(() => {
      expect(result.current.assets.some((a) => a.kind === 'fonts')).toBe(true)
    })

    await act(async () => {
      await findById(result.current.assets, 'fonts').remove()
    })

    expect(tauri.clearFontCache).toHaveBeenCalledTimes(1)
    expect(mockResetCustomFont).not.toHaveBeenCalled()
  })

  it('openSetting deep-links embed, llm, and binary to AI chat', async () => {
    mockEmbed.catalog = [embedEntry('multilingual-e5-base', 1_150_000_000)]
    mockEmbed.states = { 'multilingual-e5-base': { status: 'ready' } }
    mockLlm.catalog = [llmEntry('gemma-4-e4b-it', 1)]
    mockLlm.states = { 'gemma-4-e4b-it': { status: 'ready' } }
    mockLlm.binaryState = { status: 'ready' }
    vi.mocked(tauri.onDeviceLlmBinaryStatus).mockResolvedValue({
      installed: true,
      size_bytes: 1,
    })

    const { result } = await renderAssets()
    await waitFor(() => {
      expect(result.current.assets.some((a) => a.kind === 'llm_binary')).toBe(true)
    })

    findById(result.current.assets, 'multilingual-e5-base').openSetting()
    findById(result.current.assets, 'gemma-4-e4b-it').openSetting()
    findById(result.current.assets, BINARY_PHASE_ID).openSetting()

    expect(navigateToSetting).toHaveBeenCalledTimes(3)
    expect(navigateToSetting).toHaveBeenNthCalledWith(1, 'ai', { aiTab: 'chat' })
    expect(navigateToSetting).toHaveBeenNthCalledWith(2, 'ai', { aiTab: 'chat' })
    expect(navigateToSetting).toHaveBeenNthCalledWith(3, 'ai', { aiTab: 'chat' })
  })

  it('openSetting deep-links basemap to location geocoding and fonts to editor font', async () => {
    mockBasemap.status = 'ready'
    vi.mocked(tauri.getFontCacheStats).mockResolvedValue({ usedBytes: 10, fontCount: 1 })

    const { result } = await renderAssets()
    await waitFor(() => {
      expect(result.current.assets.some((a) => a.kind === 'fonts')).toBe(true)
    })

    findById(result.current.assets, 'basemap').openSetting()
    findById(result.current.assets, 'fonts').openSetting()

    expect(navigateToSetting).toHaveBeenNthCalledWith(1, 'location', { locationTab: 'geocoding' })
    expect(navigateToSetting).toHaveBeenNthCalledWith(2, 'editor', { editorTab: 'font' })
  })
})
