import { useEffect, useMemo, useState } from 'react'
import { getAiProviderCredentials, getAiProviders, getAiSettings } from '../lib/tauri'
import { isPrivacyExemptClass, slotIsConnected } from '../lib/aiProviderStatus'
import { useUiStore } from '../stores/uiStore'
import type { ProviderCredential } from '../types/ai'
import { getReadyLlmModels, useOnDeviceLlmModels } from './useOnDeviceLlmModels'

/**
 * Whether Daily Chat can actually call the generation slot **on this device**.
 *
 * Distinct from `useAiDailyChatEnabled` (nav visibility via feature toggle only).
 * Mirrors `useAiImageGenerationEnabled` but for the generation slot + privacy:
 *
 * - `'ready'` — toggle on, gen slot connected here, privacy ok for the class.
 * - `'needs_provider'` — no gen slot, empty chat model, or slot not connected
 *   (missing key / endpoint / undownloaded on-device LLM).
 * - `'needs_privacy'` — slot connected but hosted/subscription class lacks
 *   the per-device privacy receipt.
 * - `'off'` — feature toggle off or settings probe hard-failed.
 * - `null` — first probe in flight (disable actions, hide banner flash).
 *
 * No live HTTP probe — credential presence is the gate; the backend still
 * rejects unconfigured calls.
 */
export type DailyChatReady = 'ready' | 'needs_provider' | 'needs_privacy' | 'off'

export function useAiDailyChatReady(): DailyChatReady | null {
  const [state, setState] = useState<DailyChatReady | null>(null)
  const addedProviders = useUiStore((s) => s.addedProviders)
  const onDeviceLlm = useOnDeviceLlmModels()
  const hasDownloadedLlm = useMemo(
    () => getReadyLlmModels(onDeviceLlm.catalog, onDeviceLlm.states).length > 0,
    [onDeviceLlm.catalog, onDeviceLlm.states],
  )

  useEffect(() => {
    let cancelled = false
    Promise.all([
      getAiSettings(),
      getAiProviders(),
      getAiProviderCredentials().then(
        (rows) => ({ ok: true, rows }) as const,
        () => ({ ok: false, rows: [] as ProviderCredential[] }) as const,
      ),
    ])
      .then(([s, providers, credentialsResult]) => {
        if (cancelled) return
        if (!s.dailyChatEnabled) {
          setState('off')
          return
        }
        const gen = providers?.generation ?? null
        if (gen == null || gen.chatModel === '') {
          setState('needs_provider')
          return
        }

        if (!credentialsResult.ok) {
          // Registry unreadable — fail open for the connected check (backend
          // still rejects); still enforce privacy when we can read settings.
          if (!isPrivacyExemptClass(gen.endpointClass) && s.privacyAcceptedAt == null) {
            setState('needs_privacy')
            return
          }
          setState('ready')
          return
        }

        const credentialByPreset = new Map<string, ProviderCredential>()
        for (const c of credentialsResult.rows) credentialByPreset.set(c.presetId, c)

        if (!slotIsConnected(gen, credentialByPreset, addedProviders, hasDownloadedLlm)) {
          setState('needs_provider')
          return
        }

        if (!isPrivacyExemptClass(gen.endpointClass) && s.privacyAcceptedAt == null) {
          setState('needs_privacy')
          return
        }

        setState('ready')
      })
      .catch(() => {
        if (!cancelled) setState('off')
      })
    return () => {
      cancelled = true
    }
  }, [addedProviders, hasDownloadedLlm])

  return state
}

/** True when New/Send should be enabled. `null` (loading) stays disabled. */
export function isDailyChatActionEnabled(ready: DailyChatReady | null): boolean {
  return ready === 'ready'
}
