import { getPreset, providerIsOnDevice, providerUsesSubprocess } from '../../types/ai'

/**
 * Disconnect decision logic for the AI Settings → Providers tab.
 *
 * Extracted from `ProvidersTab.tsx` so it can be unit-tested (component
 * tests are not written per CLAUDE.md), and — more importantly — so the
 * confirm dialog's title, its body, and the action that actually runs all
 * derive from ONE predicate. They used to be computed independently, which
 * let the dialog claim "your API key will be wiped" in the title and
 * "nothing is deleted" in the body for the same card.
 */

/** Presets with no HTTP surface (CLI subprocess, on-device in-process) have
 *  nothing in the credential registry — same partition `AISettingsPanel`'s
 *  `ProviderCard` already drew around its Connection card.
 *
 *  The `getPreset` guard is load-bearing: any key that is not a real preset
 *  id passes both negative checks and would be misreported as credentialed.
 *  That is exactly how the merged `'integrated'` card key (since split into
 *  `on-device` / `on-device-llm`) made the confirm dialog promise an API-key
 *  wipe for a provider that has no key. */
export function hasCredentialSurface(presetId: string): boolean {
  if (getPreset(presetId) == null) return false
  return !providerUsesSubprocess(presetId) && !providerIsOnDevice(presetId)
}

/** Whether disconnecting this card wipes a stored endpoint + API key. This
 *  is the single source of truth for the confirm copy AND for whether
 *  `forgetCredential` runs — never re-derive it at a call site. */
export function disconnectWipesCredential(key: string): boolean {
  return hasCredentialSurface(key)
}

/** i18n keys for the Disconnect confirm dialog. Destructive presets reuse
 *  the existing `action.forget_confirm_*` copy (it already says the saved
 *  endpoint and API key are wiped); everything else gets the softer
 *  `providers_tab.disconnect_confirm_*` copy, because disconnecting them
 *  only drops the card from the connected list. */
export interface DisconnectConfirmCopy {
  titleKey: string
  bodyKey: string
}

export function disconnectConfirmCopy(key: string): DisconnectConfirmCopy {
  return disconnectWipesCredential(key)
    ? { titleKey: 'action.forget_confirm_title', bodyKey: 'action.forget_confirm_body' }
    : {
        titleKey: 'providers_tab.disconnect_confirm_title',
        bodyKey: 'providers_tab.disconnect_confirm_body',
      }
}
