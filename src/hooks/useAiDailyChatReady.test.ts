import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AIFullSettings, AIProvidersConfig, ProviderCredential } from '../types/ai'
import { isDailyChatActionEnabled, useAiDailyChatReady } from './useAiDailyChatReady'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('../lib/tauri', () => ({
  getAiSettings: vi.fn(),
  getAiProviders: vi.fn(),
  getAiProviderCredentials: vi.fn(),
  listOnDeviceLlmModels: vi.fn().mockResolvedValue([]),
  getOnDeviceLlmServerStatus: vi.fn().mockResolvedValue({ state: 'stopped' }),
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}))

import * as tauri from '../lib/tauri'
import { useUiStore } from '../stores/uiStore'

function credential(overrides: Partial<ProviderCredential> & { presetId: string }) {
  return { endpoint: '', hasApiKey: false, endpointClass: 'remote' as const, ...overrides }
}

const OPENAI_KEYED = credential({
  presetId: 'openai',
  endpoint: 'https://api.openai.com/v1',
  hasApiKey: true,
})

function settings(overrides: Partial<AIFullSettings> = {}): AIFullSettings {
  return {
    dailyChatEnabled: true,
    privacyAcceptedAt: Math.floor(Date.now() / 1000),
    ...overrides,
  } as unknown as AIFullSettings
}

const NO_SLOTS: AIProvidersConfig = { generation: null, image: null, embedding: null }

const GEN_REMOTE: AIProvidersConfig = {
  generation: {
    provider: 'openai',
    endpoint: 'https://api.openai.com/v1',
    endpointClass: 'remote',
    chatModel: 'gpt-5-mini',
    hasApiKey: true,
  },
  image: null,
  embedding: null,
}

const GEN_LOCAL: AIProvidersConfig = {
  generation: {
    provider: 'ollama',
    endpoint: 'http://127.0.0.1:11434/v1',
    endpointClass: 'local',
    chatModel: 'qwen3.5:4b',
    hasApiKey: false,
  },
  image: null,
  embedding: null,
}

const GEN_ON_DEVICE_LLM: AIProvidersConfig = {
  generation: {
    provider: 'on-device-llm',
    endpoint: '',
    endpointClass: 'on-device',
    chatModel: 'gemma-4-e4b-it',
    hasApiKey: false,
  },
  image: null,
  embedding: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  useUiStore.setState({ addedProviders: [] })
  vi.mocked(tauri.getAiSettings).mockResolvedValue(settings())
  vi.mocked(tauri.getAiProviders).mockResolvedValue(NO_SLOTS)
  vi.mocked(tauri.getAiProviderCredentials).mockResolvedValue([OPENAI_KEYED])
})

describe('useAiDailyChatReady', () => {
  it('starts null so callers can disable without flashing a banner', () => {
    const { result } = renderHook(() => useAiDailyChatReady())
    expect(result.current).toBeNull()
  })

  it('is ready when toggle on, gen slot connected, privacy accepted', async () => {
    vi.mocked(tauri.getAiProviders).mockResolvedValue(GEN_REMOTE)
    const { result } = renderHook(() => useAiDailyChatReady())
    await waitFor(() => expect(result.current).toBe('ready'))
  })

  it('is off when the daily chat feature toggle is off', async () => {
    vi.mocked(tauri.getAiSettings).mockResolvedValue(settings({ dailyChatEnabled: false }))
    vi.mocked(tauri.getAiProviders).mockResolvedValue(GEN_REMOTE)
    const { result } = renderHook(() => useAiDailyChatReady())
    await waitFor(() => expect(result.current).toBe('off'))
  })

  it('is needs_provider when no generation slot is configured', async () => {
    const { result } = renderHook(() => useAiDailyChatReady())
    await waitFor(() => expect(result.current).toBe('needs_provider'))
  })

  it('is needs_provider when gen slot has an empty chat model', async () => {
    vi.mocked(tauri.getAiProviders).mockResolvedValue({
      ...GEN_REMOTE,
      generation: { ...GEN_REMOTE.generation!, chatModel: '' },
    })
    const { result } = renderHook(() => useAiDailyChatReady())
    await waitFor(() => expect(result.current).toBe('needs_provider'))
  })

  it('is needs_provider when gen is fully selected but has no key here', async () => {
    vi.mocked(tauri.getAiProviders).mockResolvedValue({
      ...GEN_REMOTE,
      generation: { ...GEN_REMOTE.generation!, hasApiKey: false },
    })
    vi.mocked(tauri.getAiProviderCredentials).mockResolvedValue([
      credential({ presetId: 'openai', endpoint: 'https://api.openai.com/v1' }),
    ])
    const { result } = renderHook(() => useAiDailyChatReady())
    await waitFor(() => expect(result.current).toBe('needs_provider'))
  })

  it('is needs_provider for local ollama without an endpoint override', async () => {
    // Catalog default endpoint does not count as configured.
    vi.mocked(tauri.getAiProviders).mockResolvedValue(GEN_LOCAL)
    vi.mocked(tauri.getAiProviderCredentials).mockResolvedValue([
      credential({
        presetId: 'ollama',
        endpoint: 'http://127.0.0.1:11434/v1',
        endpointClass: 'local',
      }),
    ])
    const { result } = renderHook(() => useAiDailyChatReady())
    await waitFor(() => expect(result.current).toBe('needs_provider'))
  })

  it('is ready for local ollama with an endpoint override (privacy exempt)', async () => {
    vi.mocked(tauri.getAiSettings).mockResolvedValue(settings({ privacyAcceptedAt: null }))
    vi.mocked(tauri.getAiProviders).mockResolvedValue(GEN_LOCAL)
    vi.mocked(tauri.getAiProviderCredentials).mockResolvedValue([
      credential({
        presetId: 'ollama',
        endpoint: 'http://127.0.0.1:11435/v1',
        endpointClass: 'local',
      }),
    ])
    const { result } = renderHook(() => useAiDailyChatReady())
    await waitFor(() => expect(result.current).toBe('ready'))
  })

  it('is needs_privacy when remote is connected but privacy not accepted', async () => {
    vi.mocked(tauri.getAiSettings).mockResolvedValue(settings({ privacyAcceptedAt: null }))
    vi.mocked(tauri.getAiProviders).mockResolvedValue(GEN_REMOTE)
    const { result } = renderHook(() => useAiDailyChatReady())
    await waitFor(() => expect(result.current).toBe('needs_privacy'))
  })

  it('is needs_provider for on-device-llm with no downloaded model', async () => {
    vi.mocked(tauri.getAiProviders).mockResolvedValue(GEN_ON_DEVICE_LLM)
    vi.mocked(tauri.getAiProviderCredentials).mockResolvedValue([])
    const { result } = renderHook(() => useAiDailyChatReady())
    await waitFor(() => expect(result.current).toBe('needs_provider'))
  })

  it('falls back to off when settings/providers probe rejects', async () => {
    vi.mocked(tauri.getAiProviders).mockRejectedValue(new Error('ipc down'))
    const { result } = renderHook(() => useAiDailyChatReady())
    await waitFor(() => expect(result.current).toBe('off'))
  })

  it('fail-opens connected check when only the credential read fails', async () => {
    vi.mocked(tauri.getAiProviders).mockResolvedValue(GEN_REMOTE)
    vi.mocked(tauri.getAiProviderCredentials).mockRejectedValue(new Error('registry down'))
    const { result } = renderHook(() => useAiDailyChatReady())
    await waitFor(() => expect(result.current).toBe('ready'))
  })

  it('still needs_privacy when credential read fails and privacy is missing', async () => {
    vi.mocked(tauri.getAiSettings).mockResolvedValue(settings({ privacyAcceptedAt: null }))
    vi.mocked(tauri.getAiProviders).mockResolvedValue(GEN_REMOTE)
    vi.mocked(tauri.getAiProviderCredentials).mockRejectedValue(new Error('registry down'))
    const { result } = renderHook(() => useAiDailyChatReady())
    await waitFor(() => expect(result.current).toBe('needs_privacy'))
  })

  it('re-probes when addedProviders changes (CLI path)', async () => {
    vi.mocked(tauri.getAiProviders).mockResolvedValue({
      generation: {
        provider: 'claude-cli',
        endpoint: '',
        endpointClass: 'subscription',
        chatModel: 'sonnet',
        hasApiKey: false,
      },
      image: null,
      embedding: null,
    })
    vi.mocked(tauri.getAiProviderCredentials).mockResolvedValue([])
    const { result } = renderHook(() => useAiDailyChatReady())
    await waitFor(() => expect(result.current).toBe('needs_provider'))

    act(() => useUiStore.setState({ addedProviders: ['claude-cli'] }))
    await waitFor(() => expect(result.current).toBe('ready'))
  })
})

describe('isDailyChatActionEnabled', () => {
  it('is true only for ready', () => {
    expect(isDailyChatActionEnabled('ready')).toBe(true)
    expect(isDailyChatActionEnabled('needs_provider')).toBe(false)
    expect(isDailyChatActionEnabled('needs_privacy')).toBe(false)
    expect(isDailyChatActionEnabled('off')).toBe(false)
    expect(isDailyChatActionEnabled(null)).toBe(false)
  })
})
