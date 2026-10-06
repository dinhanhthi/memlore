import type { SettingsCategory } from '../stores/uiStore'
import type { Capabilities } from './platform'

/**
 * Single source of truth for which settings categories are functional under
 * the current platform's capabilities. Ungated categories are always
 * functional; each gated category maps to exactly one capability flag
 * (`ai` → ai, `reminders` → reminders, `location` → maps, `data` →
 * importExport, `security` → vaultAdmin — every Security tab is a vault-admin
 * operation the web build cannot perform).
 *
 * Every category stays visible in the SettingsPanel rail — an unavailable one
 * renders an "unsupported on web" placeholder in the detail pane. The command
 * palette's `settings.*` deep links still hide unavailable categories so they
 * can never be deep-linked to.
 */
const CATEGORY_CAPABILITY: Partial<Record<SettingsCategory, keyof Capabilities>> = {
  ai: 'ai',
  reminders: 'reminders',
  location: 'maps',
  data: 'importExport',
  security: 'vaultAdmin',
}

export function isSettingsCategoryAvailable(
  category: SettingsCategory,
  caps: Capabilities,
): boolean {
  const flag = CATEGORY_CAPABILITY[category]
  return flag === undefined || caps[flag]
}
