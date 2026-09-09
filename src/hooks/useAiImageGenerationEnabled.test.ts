import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AIFullSettings, AIProvidersConfig, ProviderCredential } from '../types/ai'
import { useAiImageGenerationEnabled } from './useAiImageGenerationEnabled'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('../lib/tauri', () => ({
  getAiSettings: vi.fn(),
  getAiProviders: vi.fn(),
  getAiProviderCredentials: vi.fn(),
}))

import * as tauri from '../lib/tauri'
import { useUiStore } from '../stores/uiStore'

/** Registry row for a preset. The hook only reads `presetId`/`endpoint`/
 *  `hasApiKey` through `slotIsConnected`. */
function credential(overrides: Partial<ProviderCredential> & { presetId: string }) {
  return { endpoint: '', hasApiKey: false, endpointClass: 'remote' as const, ...overrides }
}

const OPENAI_KEYED = credential({
  presetId: 'openai',
  endpoint: 'https://api.openai.com/v1',
  hasApiKey: true,
})

/** Only the two fields this hook reads matter; the rest of `AIFullSettings`
 *  is irrelevant here, so cast rather than restate ~40 unrelated fields. */
function settings(imageGenerationEnabled: boolean): AIFullSettings {
  return { imageGenerationEnabled } as unknown as AIFullSettings
}

const NO_SLOTS: AIProvidersConfig = { generation: null, image: null, embedding: null }

const IMAGE_CONFIGURED: AIProvidersConfig = {
  generation: null,
  image: {
    provider: 'openai',
    endpoint: 'https://api.openai.com/v1',
    endpointClass: 'remote',
    imageModel: 'gpt-image-2',
    hasApiKey: true,
  },
  embedding: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  useUiStore.setState({ addedProviders: [] })
  vi.mocked(tauri.getAiSettings).mockResolvedValue(settings(true))
  vi.mocked(tauri.getAiProviders).mockResolvedValue(NO_SLOTS)
  vi.mocked(tauri.getAiProviderCredentials).mockResolvedValue([OPENAI_KEYED])
})

describe('useAiImageGenerationEnabled', () => {
  it('starts null so the caller renders nothing until the probe lands', () => {
    const { result } = renderHook(() => useAiImageGenerationEnabled())
    expect(result.current).toBeNull()
  })

  it('returns enabled when the toggle is on and the image slot is configured', async () => {
    vi.mocked(tauri.getAiProviders).mockResolvedValue(IMAGE_CONFIGURED)
    const { result } = renderHook(() => useAiImageGenerationEnabled())
    await waitFor(() => expect(result.current).toBe('enabled'))
  })

  it('returns off when the feature toggle is off, whatever the slot says', async () => {
    vi.mocked(tauri.getAiSettings).mockResolvedValue(settings(false))
    vi.mocked(tauri.getAiProviders).mockResolvedValue(IMAGE_CONFIGURED)
    const { result } = renderHook(() => useAiImageGenerationEnabled())
    await waitFor(() => expect(result.current).toBe('off'))
  })

  // No slot at all → the remedy is finishing setup, not picking a different
  // provider, so this must NOT claim "provider doesn't support image gen".
  it('returns needs_setup when the toggle is on but no image slot is configured', async () => {
    const { result } = renderHook(() => useAiImageGenerationEnabled())
    await waitFor(() => expect(result.current).toBe('needs_setup'))
  })

  // Regression: this hook used to read `AIFullSettings.imageModel`, sourced
  // from the pre-R11 `ai_image_model` row that the migration deletes — so it
  // reported `unsupported` forever. The chat slot must NOT satisfy it either,
  // now that image is an independent provider.
  it('is needs_setup when only the CHAT slot is configured', async () => {
    vi.mocked(tauri.getAiProviders).mockResolvedValue({
      generation: {
        provider: 'openai',
        endpoint: 'https://api.openai.com/v1',
        endpointClass: 'remote',
        chatModel: 'gpt-5-mini',
        hasApiKey: true,
      },
      image: null,
      embedding: null,
    })
    const { result } = renderHook(() => useAiImageGenerationEnabled())
    await waitFor(() => expect(result.current).toBe('needs_setup'))
  })

  it('is unsupported when the image slot exists but carries no model', async () => {
    vi.mocked(tauri.getAiProviders).mockResolvedValue({
      ...IMAGE_CONFIGURED,
      image: { ...IMAGE_CONFIGURED.image!, imageModel: '' },
    })
    const { result } = renderHook(() => useAiImageGenerationEnabled())
    await waitFor(() => expect(result.current).toBe('unsupported'))
  })

  it('falls back to off when either probe rejects', async () => {
    vi.mocked(tauri.getAiProviders).mockRejectedValue(new Error('ipc down'))
    const { result } = renderHook(() => useAiImageGenerationEnabled())
    await waitFor(() => expect(result.current).toBe('off'))
  })

  // The joined-cloud-vault shape: `ai_image_provider` + `ai_gen_image_model`
  // are synced settings, the keyring is not. The slot therefore hydrates
  // fully populated on a device that cannot call it — the button must not
  // stay live and fail at call time.
  it('is needs_setup when the image slot is fully selected but has no key here', async () => {
    vi.mocked(tauri.getAiProviders).mockResolvedValue({
      ...IMAGE_CONFIGURED,
      image: { ...IMAGE_CONFIGURED.image!, hasApiKey: false },
    })
    vi.mocked(tauri.getAiProviderCredentials).mockResolvedValue([
      credential({ presetId: 'openai', endpoint: 'https://api.openai.com/v1' }),
    ])
    const { result } = renderHook(() => useAiImageGenerationEnabled())
    await waitFor(() => expect(result.current).toBe('needs_setup'))
  })

  // A synced endpoint override alone must not read as connected —
  // `ai_provider_endpoints` syncs too.
  it('is needs_setup when only a synced endpoint override is on file', async () => {
    vi.mocked(tauri.getAiProviders).mockResolvedValue({
      ...IMAGE_CONFIGURED,
      image: {
        ...IMAGE_CONFIGURED.image!,
        endpoint: 'https://proxy.example.com/v1',
        hasApiKey: false,
      },
    })
    vi.mocked(tauri.getAiProviderCredentials).mockResolvedValue([
      credential({ presetId: 'openai', endpoint: 'https://proxy.example.com/v1' }),
    ])
    const { result } = renderHook(() => useAiImageGenerationEnabled())
    await waitFor(() => expect(result.current).toBe('needs_setup'))
  })

  // A provider IS selected but carries no image model — that is the genuine
  // "can't draw" case, and it outranks the credential check because picking a
  // different provider is the remedy either way.
  it('prefers unsupported over needs_setup when a provider is selected with no model', async () => {
    vi.mocked(tauri.getAiProviders).mockResolvedValue({
      ...IMAGE_CONFIGURED,
      image: { ...IMAGE_CONFIGURED.image!, imageModel: '', hasApiKey: false },
    })
    vi.mocked(tauri.getAiProviderCredentials).mockResolvedValue([])
    const { result } = renderHook(() => useAiImageGenerationEnabled())
    await waitFor(() => expect(result.current).toBe('unsupported'))
  })

  // A CLI preset has no credential row at all — being in `addedProviders` is
  // its only "connected" signal.
  it('is enabled for a preset connected purely via addedProviders', async () => {
    useUiStore.setState({ addedProviders: ['claude-cli'] })
    vi.mocked(tauri.getAiProviders).mockResolvedValue({
      ...IMAGE_CONFIGURED,
      image: {
        ...IMAGE_CONFIGURED.image!,
        provider: 'claude-cli',
        endpoint: '',
        endpointClass: 'subscription',
        hasApiKey: false,
      },
    })
    vi.mocked(tauri.getAiProviderCredentials).mockResolvedValue([])
    const { result } = renderHook(() => useAiImageGenerationEnabled())
    await waitFor(() => expect(result.current).toBe('enabled'))
  })

  // The tooltip tells the user to go connect the provider; doing so mutates
  // `addedProviders` without remounting the editor, so the probe must re-run.
  it('re-probes when addedProviders changes after mount', async () => {
    vi.mocked(tauri.getAiProviders).mockResolvedValue({
      ...IMAGE_CONFIGURED,
      image: {
        ...IMAGE_CONFIGURED.image!,
        provider: 'claude-cli',
        endpoint: '',
        endpointClass: 'subscription',
        hasApiKey: false,
      },
    })
    vi.mocked(tauri.getAiProviderCredentials).mockResolvedValue([])
    const { result } = renderHook(() => useAiImageGenerationEnabled())
    await waitFor(() => expect(result.current).toBe('needs_setup'))

    act(() => useUiStore.setState({ addedProviders: ['claude-cli'] }))
    await waitFor(() => expect(result.current).toBe('enabled'))
  })

  // A flaky registry read must not delete a working button — mirrors the
  // permissive fallback `AISettingsPanel` uses for the same failure.
  it('stays enabled when only the credential read fails', async () => {
    vi.mocked(tauri.getAiProviders).mockResolvedValue(IMAGE_CONFIGURED)
    vi.mocked(tauri.getAiProviderCredentials).mockRejectedValue(new Error('registry down'))
    const { result } = renderHook(() => useAiImageGenerationEnabled())
    await waitFor(() => expect(result.current).toBe('enabled'))
  })
})
