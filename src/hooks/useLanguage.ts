import { useCallback } from 'react'
import { useUiStore } from '../stores/uiStore'
import {
  i18n,
  resolveLanguagePreference,
  SUPPORTED_LANGUAGES,
  type LanguagePreference,
} from '../lib/i18n'

function isLanguagePreference(value: unknown): value is LanguagePreference {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(value as string)
}

async function applyLanguage(pref: LanguagePreference): Promise<void> {
  const concrete = resolveLanguagePreference(pref)
  if (i18n.language !== concrete) {
    await i18n.changeLanguage(concrete)
  }
}

/**
 * Apply the uiStore's current `uiLanguage` to i18next. Called from an
 * ungated mount effect in `App.tsx` — deliberately NOT gated on `dbReady`
 * like the DB-backed hydrations, because language must apply before unlock
 * for the lock screen's language toggle.
 *
 * In practice this is a guaranteed no-op today: `i18n.ts` already
 * initializes `lng` from `readPersistedLanguage()` (the same localStorage
 * source) at module init, and both paths coerce invalid values identically,
 * so `applyLanguage()` below always finds `i18n.language` already matches
 * and early-returns. It's kept as scaffolding for the pre-unlock toggle and
 * to mirror the sibling `hydrateX()` effects — not dead code to delete.
 *
 * Safe to call repeatedly: idempotent against the live i18next state.
 */
export async function hydrateLanguage(): Promise<void> {
  const pref = useUiStore.getState().uiLanguage
  await applyLanguage(pref)
}

/** Non-reactive read — for command palette and non-React callers. */
export function getLanguage(): LanguagePreference {
  return useUiStore.getState().uiLanguage
}

/** Imperative setter — for command palette and non-React callers. */
export async function setLanguageImperative(pref: LanguagePreference): Promise<void> {
  if (!isLanguagePreference(pref)) {
    throw new Error(`Unsupported language preference: ${String(pref)}`)
  }
  useUiStore.getState().setUiLanguage(pref)
  await applyLanguage(pref)
}

/// React hook owning the UI language lifecycle.
///
/// - Hydration: handled at app shell level via `hydrateLanguage()`. The hook
///   itself only exposes the live Zustand value + the setter.
/// - `setLanguage(pref)` updates the store and switches `i18next`; the
///   store's `persist` middleware writes it to `localStorage`.
///
/// The authoritative source of truth is `localStorage['memlore-ui']`
/// (per-device, never synced) — Zustand is the live mirror components
/// subscribe to.
export function useLanguage() {
  const uiLanguage = useUiStore((s) => s.uiLanguage)
  const setUiLanguage = useUiStore((s) => s.setUiLanguage)

  const setLanguage = useCallback(
    async (pref: LanguagePreference) => {
      if (!isLanguagePreference(pref)) {
        throw new Error(`Unsupported language preference: ${String(pref)}`)
      }
      setUiLanguage(pref)
      await applyLanguage(pref)
    },
    [setUiLanguage],
  )

  return { uiLanguage, setLanguage }
}
