import { useEffect, useState } from 'react'
import { getAiProviderCredentials, getAiProviders, getAiSettings } from '../lib/tauri'
import { slotIsConnected } from '../lib/aiProviderStatus'
import { useUiStore } from '../stores/uiStore'
import type { ProviderCredential } from '../types/ai'

/**
 * Probe for image-gen availability (Phase 6 v2 R10).
 *
 * Reads the dedicated IMAGE slot (independent of the chat slot since
 * 2026-08-07). It used to read `AIFullSettings.imageModel`, which was
 * sourced from the pre-R11 `ai_image_model` row that the R11 migration
 * deletes — so that check had been silently dead.
 *
 * Returns a four-state suitable for UI gating:
 * - `'enabled'` — toggle on, image slot connected, model chosen.
 * - `'unsupported'` — a provider IS selected for the image slot but carries
 *   no image model, i.e. it can't draw. The button renders disabled with a
 *   "doesn't support image generation" tooltip; the remedy is picking a
 *   different provider/model.
 * - `'needs_setup'` — the slot is unset, or it is set but has no usable
 *   credential ON THIS DEVICE. Distinct from `'unsupported'` because the
 *   remedy is to finish setting the slot up, not to choose something else.
 * - `'off'` — toggle off or the settings probe failed.
 * - `null` — first probe in flight; render nothing to avoid a flash.
 *
 * Why the credential read: the slot's provider/model rows are synced
 * settings but the keyring is not (see `slotIsConnected`), so a device that
 * adopted an existing cloud vault hydrates `providers.image != null` with no
 * key. Gating on `!= null` there left the editor offering a live button that
 * failed at call time while AI Settings correctly reported it unavailable.
 */
export type ImageGenAvailability = 'enabled' | 'unsupported' | 'needs_setup' | 'off'

export function useAiImageGenerationEnabled(): ImageGenAvailability | null {
  const [state, setState] = useState<ImageGenAvailability | null>(null)
  const addedProviders = useUiStore((s) => s.addedProviders)

  useEffect(() => {
    let cancelled = false
    // Credentials are read with `allSettled`, unlike the two `all` reads: a
    // failed registry read must NOT hide a working button. `AISettingsPanel`
    // makes the same call for the same reason — treating "couldn't read" as
    // "nothing connected" turns one flaky IPC into a dead feature.
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
        if (!s.imageGenerationEnabled) {
          setState('off')
          return
        }
        // Image generation is available iff the image slot itself is
        // configured — the chat slot is irrelevant now that the two are
        // separate providers.
        const image = providers?.image ?? null
        if (image == null) {
          setState('needs_setup')
          return
        }
        if (image.imageModel === '') {
          setState('unsupported')
          return
        }
        if (!credentialsResult.ok) {
          // Registry unreadable — fall back to the pre-`slotIsConnected`
          // permissive answer rather than disabling a button that probably
          // works. The backend still rejects an unconfigured call.
          setState('enabled')
          return
        }
        const credentialByPreset = new Map<string, ProviderCredential>()
        for (const c of credentialsResult.rows) credentialByPreset.set(c.presetId, c)
        // `hasDownloadedIntegratedModel: false` is safe not because the flag
        // is unused for image slots — `providerIsConfigured` reads it for ANY
        // on-device preset — but because neither on-device preset declares the
        // `image` capability, and a stale synced row naming one would resolve
        // to `needs_setup`, i.e. fail closed.
        setState(
          slotIsConnected(image, credentialByPreset, addedProviders, false)
            ? 'enabled'
            : 'needs_setup',
        )
      })
      .catch(() => {
        if (!cancelled) setState('off')
      })
    return () => {
      cancelled = true
    }
  }, [addedProviders])

  return state
}
