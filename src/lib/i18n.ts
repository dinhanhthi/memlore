import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import enCommon from '../locales/en/common.json'
import enNav from '../locales/en/nav.json'
import enEditor from '../locales/en/editor.json'
import enSettings from '../locales/en/settings.json'
import enAuth from '../locales/en/auth.json'
import enErrors from '../locales/en/errors.json'
import enExport from '../locales/en/export.json'
import enImport from '../locales/en/import.json'
import enNotifications from '../locales/en/notifications.json'
import enStats from '../locales/en/stats.json'
import enDashboard from '../locales/en/dashboard.json'
import enAi from '../locales/en/ai.json'
import enPalette from '../locales/en/palette.json'
import viCommon from '../locales/vi/common.json'
import viNav from '../locales/vi/nav.json'
import viEditor from '../locales/vi/editor.json'
import viSettings from '../locales/vi/settings.json'
import viAuth from '../locales/vi/auth.json'
import viErrors from '../locales/vi/errors.json'
import viExport from '../locales/vi/export.json'
import viImport from '../locales/vi/import.json'
import viNotifications from '../locales/vi/notifications.json'
import viStats from '../locales/vi/stats.json'
import viDashboard from '../locales/vi/dashboard.json'
import viAi from '../locales/vi/ai.json'
import viPalette from '../locales/vi/palette.json'

import { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE } from './languages'
import type { SupportedLanguage, LanguagePreference } from './languages'
import { readPersistedLanguage } from './persistedLanguage'

// Re-exported for existing consumers (uiStore.ts, useLanguage.ts,
// LanguageSelector.tsx, …). The canonical source is `./languages` — see
// that file for why these live there instead of here.
export { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE }
export type { SupportedLanguage, LanguagePreference }

const resources = {
  en: {
    common: enCommon,
    nav: enNav,
    editor: enEditor,
    settings: enSettings,
    auth: enAuth,
    errors: enErrors,
    export: enExport,
    import: enImport,
    notifications: enNotifications,
    stats: enStats,
    dashboard: enDashboard,
    ai: enAi,
    palette: enPalette,
  },
  vi: {
    common: viCommon,
    nav: viNav,
    editor: viEditor,
    settings: viSettings,
    auth: viAuth,
    errors: viErrors,
    export: viExport,
    import: viImport,
    notifications: viNotifications,
    stats: viStats,
    dashboard: viDashboard,
    ai: viAi,
    palette: viPalette,
  },
} as const

i18next.use(initReactI18next).init({
  resources,
  lng: readPersistedLanguage(),
  fallbackLng: DEFAULT_LANGUAGE,
  supportedLngs: [...SUPPORTED_LANGUAGES],
  ns: [
    'common',
    'nav',
    'editor',
    'settings',
    'auth',
    'errors',
    'export',
    'import',
    'notifications',
    'stats',
    'dashboard',
    'ai',
    'palette',
  ],
  defaultNS: 'common',
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
})

/// Resolve a navigator-style language tag (`'vi-VN'`, `'en-US'`, …) to one of
/// our supported codes. Falls back to `'en'` for anything we don't ship.
export function resolveSystemLanguage(tag: string | null | undefined): SupportedLanguage {
  if (!tag) return DEFAULT_LANGUAGE
  const lower = tag.toLowerCase()
  for (const code of SUPPORTED_LANGUAGES) {
    if (lower === code || lower.startsWith(`${code}-`)) return code
  }
  return DEFAULT_LANGUAGE
}

export function resolveLanguagePreference(pref: LanguagePreference): SupportedLanguage {
  return pref
}

export const i18n = i18next
export default i18next
