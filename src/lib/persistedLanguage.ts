import { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES, type LanguagePreference } from './languages'

/**
 * localStorage key used by the Zustand `persist` middleware for
 * `useUiStore` (src/stores/uiStore.ts, `persist(..., { name: 'memlore-ui' })`).
 * Must match that store's `name` option exactly. Duplicated here (rather
 * than imported from `uiStore.ts`) because `i18n.ts` reads the persisted
 * language before any store hydrates — importing the store itself would
 * pull in its full initialization.
 */
export const UI_STORAGE_KEY = 'memlore-ui'

function isSupportedLanguage(value: unknown): value is LanguagePreference {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(value as string)
}

/**
 * Reads the persisted interface language directly from localStorage,
 * bypassing `useUiStore` (which has not hydrated yet when `i18n.ts`
 * initializes). Never throws: a missing key, malformed JSON, JSON missing
 * `state`/`uiLanguage`, an unsupported language value, or a `localStorage`
 * access failure (e.g. restricted context) all fall back to
 * `DEFAULT_LANGUAGE`.
 */
export function readPersistedLanguage(): LanguagePreference {
  try {
    const raw = localStorage.getItem(UI_STORAGE_KEY)
    if (!raw) return DEFAULT_LANGUAGE

    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_LANGUAGE

    const state = (parsed as { state?: unknown }).state
    if (typeof state !== 'object' || state === null) return DEFAULT_LANGUAGE

    const uiLanguage = (state as { uiLanguage?: unknown }).uiLanguage
    return isSupportedLanguage(uiLanguage) ? uiLanguage : DEFAULT_LANGUAGE
  } catch {
    return DEFAULT_LANGUAGE
  }
}
