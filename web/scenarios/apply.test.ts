import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useForceRePairStore } from '../../src/hooks/useForceRePair'
import { useSettingsStore } from '../../src/stores/settingsStore'
import { useAiSettingsStore } from '../../src/stores/aiSettingsStore'
import { getActiveScenario } from '../mocks/activeScenario'
import { applyScenario } from './apply'

describe('applyScenario', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      encryptionMode: 'password',
      isLocked: true,
      isBiometricEnabled: true,
    })
    useForceRePairStore.getState().setForceRePair('key-rotation')
  })

  it('resets auth stores before switching to a logged-in scenario', () => {
    const remount = vi.fn()

    const resolved = applyScenario('logged-in', remount)

    expect(resolved).toBe('logged-in')
    expect(getActiveScenario().id).toBe('logged-in')
    expect(useSettingsStore.getState().encryptionMode).toBe(null)
    expect(useSettingsStore.getState().isLocked).toBe(false)
    expect(useSettingsStore.getState().isBiometricEnabled).toBe(false)
    expect(useForceRePairStore.getState().forceRePairRequired).toBe(false)
    expect(remount).toHaveBeenCalledOnce()
  })

  it('resets auth stores before switching back to a locked scenario', () => {
    const remount = vi.fn()

    applyScenario('logged-in', () => {})
    applyScenario('locked', remount)

    expect(getActiveScenario().id).toBe('locked')
    expect(useSettingsStore.getState().encryptionMode).toBe(null)
    expect(useForceRePairStore.getState().forceRePairRequired).toBe(false)
    expect(remount).toHaveBeenCalledOnce()
  })

  it('resets the shared AI snapshot before a same-page scenario switch', () => {
    const initialRefreshProviders = useAiSettingsStore.getInitialState().refreshProviders
    const previousSettingsRequestSeq = useAiSettingsStore.getState().settingsRequestSeq
    const previousRequestSeq = useAiSettingsStore.getState().providerRequestSeq
    useAiSettingsStore.setState({
      providersHydrated: true,
      providers: {
        generation: {
          provider: 'openai',
          endpoint: 'https://api.openai.com/v1',
          endpointClass: 'remote',
          chatModel: 'gpt-5-mini',
          hasApiKey: true,
        },
        image: null,
        embedding: null,
      },
    })

    applyScenario('ai-connected', () => {})

    const state = useAiSettingsStore.getState()
    expect(state.providersHydrated).toBe(false)
    expect(state.providers).toEqual({ generation: null, image: null, embedding: null })
    expect(state.refreshProviders).toBe(initialRefreshProviders)
    expect(state.settingsRequestSeq).toBeGreaterThan(previousSettingsRequestSeq)
    expect(state.providerRequestSeq).toBeGreaterThan(previousRequestSeq)
  })
})
