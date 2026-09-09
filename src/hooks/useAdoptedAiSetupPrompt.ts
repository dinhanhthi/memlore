import { useCallback, useEffect, useMemo, useState } from 'react'
import { create } from 'zustand'
import {
  ADOPT_SETUP_DISMISS_KEY,
  adoptedAiSetupFingerprint,
  shouldPromptAdoptedAiSetup,
  snapshotAdoptSlots,
} from '../lib/adoptedAiSetup'
import {
  resolveAiSetupAttention,
  slotIsConnected,
  type AiModelSlotId,
} from '../lib/aiProviderStatus'
import { getAiProviderCredentials, getAiSettings, getSetting, setSetting } from '../lib/tauri'
import { useAiSettingsStore } from '../stores/aiSettingsStore'
import { useOnboardingStore } from '../stores/onboardingStore'
import { useUiStore } from '../stores/uiStore'
import type { ProviderCredential } from '../types/ai'
import { getReadyLlmModels, useOnDeviceLlmModels } from './useOnDeviceLlmModels'
import { getReadyModels, useOnDeviceModels } from './useOnDeviceModels'

/** Shared "is the adopt prompt covering the shell" flag so sibling
 *  modals (embedding decision) can yield without a second hook instance. */
export const useAdoptedAiSetupOpen = create<{ open: boolean }>(() => ({ open: false }))

export function useAdoptedAiSetupPrompt() {
  const providers = useAiSettingsStore((s) => s.providers)
  const providersHydrated = useAiSettingsStore((s) => s.providersHydrated)
  const onboardingPending = useOnboardingStore((s) => s.pending)
  const celebrationPending = useOnboardingStore((s) => s.celebrationPending)
  const addedProviders = useUiStore((s) => s.addedProviders)

  const onDeviceEmbed = useOnDeviceModels()
  const onDeviceLlm = useOnDeviceLlmModels()
  const readyOnDevice = useMemo(
    () => ({
      embed: getReadyModels(onDeviceEmbed.catalog, onDeviceEmbed.states).length > 0,
      llm: getReadyLlmModels(onDeviceLlm.catalog, onDeviceLlm.states).length > 0,
    }),
    [onDeviceEmbed.catalog, onDeviceEmbed.states, onDeviceLlm.catalog, onDeviceLlm.states],
  )

  const [credentials, setCredentials] = useState<ProviderCredential[]>([])
  const [credentialsLoaded, setCredentialsLoaded] = useState(false)
  const [dismissedFingerprint, setDismissedFingerprint] = useState<string | null>(null)
  const [auxHydrated, setAuxHydrated] = useState(false)
  const [privacyAcceptedAt, setPrivacyAcceptedAt] = useState<number | null>(null)
  const [phase, setPhase] = useState<'ask' | 'wizard'>('ask')
  const [wizardSlots, setWizardSlots] = useState<AiModelSlotId[] | null>(null)

  useEffect(() => {
    if (useAiSettingsStore.getState().providersHydrated) return
    void useAiSettingsStore.getState().hydrateProviders()
  }, [])

  useEffect(() => {
    if (!providersHydrated) return
    let cancelled = false
    void (async () => {
      const [credsResult, dismissResult, settingsResult] = await Promise.allSettled([
        getAiProviderCredentials(),
        getSetting(ADOPT_SETUP_DISMISS_KEY),
        getAiSettings(),
      ])
      if (cancelled) return
      if (credsResult.status === 'fulfilled') {
        setCredentials(credsResult.value)
        setCredentialsLoaded(true)
      }
      // A later refresh failure must not flip credentialsLoaded back to
      // false — that would unmount an already-open wizard. First-load
      // failure stays closed because the flag starts false.
      if (dismissResult.status === 'fulfilled') {
        setDismissedFingerprint(dismissResult.value)
      }
      if (settingsResult.status === 'fulfilled' && settingsResult.value != null) {
        setPrivacyAcceptedAt(settingsResult.value.privacyAcceptedAt)
      }
      setAuxHydrated(true)
    })()
    return () => {
      cancelled = true
    }
  }, [providersHydrated, providers])

  const credentialByPreset = useMemo(() => {
    const map = new Map<string, ProviderCredential>()
    for (const row of credentials) map.set(row.presetId, row)
    return map
  }, [credentials])

  const gen = providers.generation
  const image = providers.image
  const embed = providers.embedding
  const genConnected = slotIsConnected(gen, credentialByPreset, addedProviders, readyOnDevice.llm)
  const imageConnected = slotIsConnected(
    image,
    credentialByPreset,
    addedProviders,
    readyOnDevice.llm,
  )
  const embedConnected = slotIsConnected(
    embed,
    credentialByPreset,
    addedProviders,
    readyOnDevice.embed,
  )
  const anyConnected = genConnected || imageConnected || embedConnected

  const issues = useMemo(
    () =>
      resolveAiSetupAttention({
        gen: { config: gen, connected: genConnected },
        image: { config: image, connected: imageConnected },
        embed: { config: embed, connected: embedConnected },
        privacyAcceptedAt,
      }),
    [gen, image, embed, genConnected, imageConnected, embedConnected, privacyAcceptedAt],
  )

  const currentFingerprint = adoptedAiSetupFingerprint(providers)
  const shouldPrompt =
    auxHydrated &&
    shouldPromptAdoptedAiSetup({
      issues,
      anyConnected,
      dismissedFingerprint,
      currentFingerprint,
      credentialsLoaded,
    })
  const gated = !onboardingPending && !celebrationPending
  // Stay mounted for the whole wizard even after the first slot connects —
  // otherwise saving the chat key unmounts AIStep before embed/privacy.
  const open = gated && (phase === 'wizard' || shouldPrompt)

  // Publish in render so EmbeddingSyncDecisionModal yields the same frame
  // (a post-paint effect left one frame where both modals could stack).
  if (useAdoptedAiSetupOpen.getState().open !== open) {
    useAdoptedAiSetupOpen.setState({ open })
  }
  useEffect(() => {
    return () => {
      useAdoptedAiSetupOpen.setState({ open: false })
    }
  }, [])

  const liveSlots: AiModelSlotId[] = useMemo(() => {
    const issue = issues.find((item) => item.kind === 'slots_not_connected')
    const notConnected = issue?.kind === 'slots_not_connected' ? issue.slots : []
    return snapshotAdoptSlots(notConnected, providers)
  }, [issues, providers])

  const slots = phase === 'wizard' && wizardSlots != null ? wizardSlots : liveSlots

  useEffect(() => {
    if (phase !== 'wizard' || wizardSlots == null) return
    setWizardSlots((prev) => {
      if (prev == null) return liveSlots
      const merged = snapshotAdoptSlots([...prev, ...liveSlots], providers)
      if (merged.length === prev.length && merged.every((id, i) => id === prev[i])) {
        return prev
      }
      return merged
    })
  }, [phase, liveSlots, providers, wizardSlots])

  const startWizard = useCallback(() => {
    setWizardSlots(snapshotAdoptSlots(liveSlots, useAiSettingsStore.getState().providers))
    setPhase('wizard')
  }, [liveSlots])

  const backToAsk = useCallback(() => {
    setPhase('ask')
    setWizardSlots(null)
  }, [])

  const dismiss = useCallback(async () => {
    await setSetting(ADOPT_SETUP_DISMISS_KEY, currentFingerprint)
    setDismissedFingerprint(currentFingerprint)
    setPhase('ask')
    setWizardSlots(null)
  }, [currentFingerprint])

  const complete = useCallback(async () => {
    setPhase('ask')
    setWizardSlots(null)
    // Persist dismiss even when the user skipped remaining slots, otherwise
    // a still-keyless snapshot re-opens the modal on the next refresh.
    await setSetting(ADOPT_SETUP_DISMISS_KEY, currentFingerprint)
    setDismissedFingerprint(currentFingerprint)
    await useAiSettingsStore.getState().refreshProviders()
  }, [currentFingerprint])

  return {
    open,
    phase,
    slots,
    providers,
    startWizard,
    backToAsk,
    dismiss,
    complete,
  }
}
