import type { Tab } from '../stores/tabStore'
import { useTabStore } from '../stores/tabStore'
import type { SettingsCategory } from '../stores/uiStore'

/**
 * Stable anchor-key identifiers for deep-link target rows in Settings.
 * Each key maps to the `id` attribute set on the corresponding
 * `SettingsRow` / control element: `"settings-anchor-<value>"`.
 *
 * Phase 2 palette deep-link commands import this map to reference
 * anchors by semantic key rather than raw id strings.
 */
export const SETTINGS_ANCHORS = {
  // Appearance
  accentColor: 'settings-anchor-accent-color',
  surfaceStyle: 'settings-anchor-surface-style',

  // Sync
  syncInterval: 'settings-anchor-sync-interval',

  // Media
  cacheLimit: 'settings-anchor-cache-limit',
  compressionMode: 'settings-anchor-compression-mode',
  uploadLimits: 'settings-anchor-upload-limits',

  // Location
  geocodingProvider: 'settings-anchor-geocoding-provider',
  geocodingApiKey: 'settings-anchor-geocoding-api-key',

  // Security
  biometric: 'settings-anchor-biometric',
  changePassword: 'settings-anchor-change-password',
  secondLockAutoLock: 'settings-anchor-second-lock-auto-lock',
  invisibleLockAutoLock: 'settings-anchor-invisible-lock-auto-lock',

  // AI
  responseLanguage: 'settings-anchor-response-language',
  emotionLanguage: 'settings-anchor-emotion-language',
  dailyChatPersona: 'settings-anchor-daily-chat-persona',
  memoryIncludeProtected: 'settings-anchor-memory-include-protected',
  memoryModelGen: 'settings-anchor-memory-model-gen',
  memoryModelEmbed: 'settings-anchor-memory-model-embed',

  // Editor
  fontFamily: 'settings-anchor-font-family',
  fontSize: 'settings-anchor-font-size',
  fontContrast: 'settings-anchor-font-contrast',
} as const

export type SettingsAnchorKey = keyof typeof SETTINGS_ANCHORS

/** Sub-tab fields that can be patched when navigating to a setting. */
type SubTabPatch = Partial<
  Pick<
    Tab,
    | 'securityTab'
    | 'locationTab'
    | 'aiTab'
    | 'templatesTab'
    | 'dataTab'
    | 'editorTab'
    | 'appearanceTab'
    | 'syncTab'
  >
>

/**
 * Navigate to a specific settings row. Sets the category + sub-tab so the
 * correct pane is visible, then stamps `settingsAnchor` so `SettingsPanel`
 * can scroll to and highlight the target row.
 *
 * Phase 2 palette commands call this from their `run()` handler.
 */
export function navigateToSetting(
  category: SettingsCategory,
  subTabPatch: SubTabPatch,
  anchorId?: string,
): void {
  useTabStore.getState().updateActiveTab({
    activeView: 'settings',
    selectedEntryId: null,
    settingsCategory: category,
    ...subTabPatch,
    settingsAnchor: anchorId ?? null,
  })
}
