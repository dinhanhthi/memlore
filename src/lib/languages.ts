// Leaf module for supported-language constants/types. Extracted out of
// `i18n.ts` so `persistedLanguage.ts` can depend on these without creating
// a cycle: `i18n.ts` imports `persistedLanguage.ts` to read the persisted
// language at init time, so `persistedLanguage.ts` cannot import back from
// `i18n.ts`. Both now import from here instead.

export const SUPPORTED_LANGUAGES = ['en', 'vi'] as const
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]
export type LanguagePreference = SupportedLanguage

export const DEFAULT_LANGUAGE: SupportedLanguage = 'en'
