import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AIProvidersConfig, ProviderCredential } from '../types/ai'
import { ADOPT_SETUP_DISMISS_KEY, adoptedAiSetupFingerprint } from '../lib/adoptedAiSetup'
import { resetAiSettingsStore, useAiSettingsStore } from '../stores/aiSettingsStore'
import { useOnboardingStore } from '../stores/onboardingStore'
import { useUiStore } from '../stores/uiStore'
import { useAdoptedAiSetupOpen, useAdoptedAiSetupPrompt } from './useAdoptedAiSetupPrompt'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('../lib/tauri', () => ({
  getAiProviderCredentials: vi.fn(),
  getAiSettings: vi.fn(),
  getAiProviders: vi.fn(),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}))
vi.mock('./useOnDeviceModels', () => ({
  useOnDeviceModels: () => ({ catalog: [], states: {} }),
  getReadyModels: () => [],
}))
vi.mock('./useOnDeviceLlmModels', () => ({
  useOnDeviceLlmModels: () => ({ catalog: [], states: {} }),
  getReadyLlmModels: () => [],
}))

import * as tauri from '../lib/tauri'

function credential(
  overrides: Partial<ProviderCredential> & { presetId: string },
): ProviderCredential {
  return {
    endpoint: '',
    hasApiKey: false,
    endpointClass: 'remote',
    ...overrides,
  }
}

const OPENAI_KEYLESS = credential({
  presetId: 'openai',
  endpoint: 'https://api.openai.com/v1',
  hasApiKey: false,
})

const VOYAGE_KEYLESS = credential({
  presetId: 'voyage',
  endpoint: 'https://api.voyageai.com/v1',
  hasApiKey: false,
})

const ADOPTED: AIProvidersConfig = {
  generation: {
    provider: 'openai',
    endpoint: 'https://api.openai.com/v1',
    endpointClass: 'remote',
    chatModel: 'gpt-5-mini',
    hasApiKey: false,
  },
  image: null,
  embedding: {
    provider: 'voyage',
    endpoint: 'https://api.voyageai.com/v1',
    endpointClass: 'remote',
    embeddingModel: 'voyage-3',
    hasApiKey: false,
  },
}

const GREENFIELD: AIProvidersConfig = {
  generation: null,
  image: null,
  embedding: null,
}

function seedProviders(providers: AIProvidersConfig, hydrated = true): void {
  useAiSettingsStore.setState({
    providers,
    providersHydrated: hydrated,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  resetAiSettingsStore()
  useUiStore.setState({ addedProviders: [] })
  useOnboardingStore.setState({
    pending: false,
    celebrationPending: false,
    celebrationVariant: 'setup',
  })
  useAdoptedAiSetupOpen.setState({ open: false })
  vi.mocked(tauri.getAiProviderCredentials).mockResolvedValue([OPENAI_KEYLESS, VOYAGE_KEYLESS])
  vi.mocked(tauri.getSetting).mockResolvedValue(null)
  vi.mocked(tauri.setSetting).mockResolvedValue(undefined)
  vi.mocked(tauri.getAiSettings).mockResolvedValue({ privacyAcceptedAt: null } as never)
  vi.mocked(tauri.getAiProviders).mockResolvedValue(ADOPTED)
})

describe('useAdoptedAiSetupPrompt', () => {
  it('stays closed for a greenfield vault', async () => {
    seedProviders(GREENFIELD)
    const { result } = renderHook(() => useAdoptedAiSetupPrompt())
    await waitFor(() => expect(tauri.getAiProviderCredentials).toHaveBeenCalled())
    expect(result.current.open).toBe(false)
  })

  it('opens on synced-but-keyless slots and lists them', async () => {
    seedProviders(ADOPTED)
    const { result } = renderHook(() => useAdoptedAiSetupPrompt())
    await waitFor(() => expect(result.current.open).toBe(true))
    expect(result.current.phase).toBe('ask')
    expect(result.current.slots).toEqual(['chat', 'embed'])
    expect(result.current.providers).toEqual(ADOPTED)
  })

  it('stays closed when the same fingerprint was dismissed', async () => {
    seedProviders(ADOPTED)
    vi.mocked(tauri.getSetting).mockResolvedValue(adoptedAiSetupFingerprint(ADOPTED))
    const { result } = renderHook(() => useAdoptedAiSetupPrompt())
    await waitFor(() => expect(tauri.getSetting).toHaveBeenCalledWith(ADOPT_SETUP_DISMISS_KEY))
    expect(result.current.open).toBe(false)
  })

  it('re-opens when the cloud fingerprint changed after dismiss', async () => {
    seedProviders(ADOPTED)
    vi.mocked(tauri.getSetting).mockResolvedValue(
      'chat:anthropic:claude-sonnet-4|image:-|embed:voyage:voyage-3',
    )
    const { result } = renderHook(() => useAdoptedAiSetupPrompt())
    await waitFor(() => expect(result.current.open).toBe(true))
  })

  it('keeps an open prompt if a later credential refresh fails', async () => {
    seedProviders(ADOPTED)
    const { result } = renderHook(() => useAdoptedAiSetupPrompt())
    await waitFor(() => expect(result.current.open).toBe(true))

    vi.mocked(tauri.getAiProviderCredentials).mockRejectedValueOnce(new Error('ipc'))
    act(() => {
      seedProviders({
        ...ADOPTED,
        generation: { ...ADOPTED.generation!, chatModel: 'gpt-5.4' },
      })
    })

    await waitFor(() => expect(tauri.getAiProviderCredentials).toHaveBeenCalledTimes(2))
    expect(result.current.open).toBe(true)
  })

  it('stays closed when the credential registry read fails', async () => {
    seedProviders(ADOPTED)
    vi.mocked(tauri.getAiProviderCredentials).mockRejectedValue(new Error('ipc'))
    const { result } = renderHook(() => useAdoptedAiSetupPrompt())
    await waitFor(() => expect(tauri.getAiProviderCredentials).toHaveBeenCalled())
    expect(result.current.open).toBe(false)
  })

  it('stays closed while onboarding is pending', async () => {
    seedProviders(ADOPTED)
    useOnboardingStore.setState({ pending: true })
    const { result } = renderHook(() => useAdoptedAiSetupPrompt())
    await waitFor(() => expect(tauri.getAiProviderCredentials).toHaveBeenCalled())
    expect(result.current.open).toBe(false)
  })

  it('waits for the celebration modal, then opens', async () => {
    seedProviders(ADOPTED)
    useOnboardingStore.setState({ celebrationPending: true })
    const { result } = renderHook(() => useAdoptedAiSetupPrompt())
    await waitFor(() => expect(tauri.getAiProviderCredentials).toHaveBeenCalled())
    expect(result.current.open).toBe(false)

    act(() => {
      useOnboardingStore.getState().dismissCelebration()
    })
    await waitFor(() => expect(result.current.open).toBe(true))
  })

  it('startWizard moves to the wizard phase', async () => {
    seedProviders(ADOPTED)
    const { result } = renderHook(() => useAdoptedAiSetupPrompt())
    await waitFor(() => expect(result.current.open).toBe(true))
    act(() => {
      result.current.startWizard()
    })
    expect(result.current.phase).toBe('wizard')
    expect(result.current.open).toBe(true)
  })

  it('keeps the wizard open after the first slot connects and does not shrink slots', async () => {
    seedProviders(ADOPTED)
    const { result } = renderHook(() => useAdoptedAiSetupPrompt())
    await waitFor(() => expect(result.current.open).toBe(true))
    act(() => {
      result.current.startWizard()
    })
    expect(result.current.slots).toEqual(['chat', 'embed'])

    vi.mocked(tauri.getAiProviderCredentials).mockResolvedValue([
      { ...OPENAI_KEYLESS, hasApiKey: true },
      VOYAGE_KEYLESS,
    ])
    act(() => {
      seedProviders({
        generation: { ...ADOPTED.generation!, hasApiKey: true },
        image: null,
        embedding: ADOPTED.embedding,
      })
    })

    await waitFor(() => expect(tauri.getAiProviderCredentials).toHaveBeenCalledTimes(2))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.phase).toBe('wizard')
    expect(result.current.open).toBe(true)
    expect(result.current.slots).toEqual(['chat', 'embed'])
  })

  it('backToAsk returns from the wizard without dismissing', async () => {
    seedProviders(ADOPTED)
    const { result } = renderHook(() => useAdoptedAiSetupPrompt())
    await waitFor(() => expect(result.current.open).toBe(true))
    act(() => {
      result.current.startWizard()
    })
    act(() => {
      result.current.backToAsk()
    })
    expect(result.current.phase).toBe('ask')
    expect(result.current.open).toBe(true)
    expect(tauri.setSetting).not.toHaveBeenCalled()
  })

  it('dismiss writes the current fingerprint and closes', async () => {
    seedProviders(ADOPTED)
    const { result } = renderHook(() => useAdoptedAiSetupPrompt())
    await waitFor(() => expect(result.current.open).toBe(true))
    await act(async () => {
      await result.current.dismiss()
    })
    expect(tauri.setSetting).toHaveBeenCalledWith(
      ADOPT_SETUP_DISMISS_KEY,
      adoptedAiSetupFingerprint(ADOPTED),
    )
    expect(result.current.open).toBe(false)
    expect(result.current.phase).toBe('ask')
  })

  it('complete writes the fingerprint so a skipped wizard does not reopen', async () => {
    seedProviders(ADOPTED)
    const { result } = renderHook(() => useAdoptedAiSetupPrompt())
    await waitFor(() => expect(result.current.open).toBe(true))
    await act(async () => {
      await result.current.complete()
    })
    expect(tauri.setSetting).toHaveBeenCalledWith(
      ADOPT_SETUP_DISMISS_KEY,
      adoptedAiSetupFingerprint(ADOPTED),
    )
    expect(result.current.open).toBe(false)
  })

  it('complete refreshes providers and closes once a slot is connected', async () => {
    seedProviders(ADOPTED)
    const connected: AIProvidersConfig = {
      generation: { ...ADOPTED.generation!, hasApiKey: true },
      image: null,
      embedding: { ...ADOPTED.embedding!, hasApiKey: true },
    }
    vi.mocked(tauri.getAiProviders).mockResolvedValue(connected)
    vi.mocked(tauri.getAiProviderCredentials).mockResolvedValue([
      { ...OPENAI_KEYLESS, hasApiKey: true },
      { ...VOYAGE_KEYLESS, hasApiKey: true },
    ])

    const { result } = renderHook(() => useAdoptedAiSetupPrompt())
    await waitFor(() => expect(result.current.open).toBe(true))

    await act(async () => {
      await result.current.complete()
    })

    await waitFor(() => expect(result.current.open).toBe(false))
  })
})
