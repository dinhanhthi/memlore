import type { SettingsCategory } from '../stores/uiStore'
import type { Capabilities } from './platform'

/**
 * Single source of truth for which settings categories are visible under the
 * current platform's capabilities. Ungated categories are always visible; each
 * gated category maps to exactly one capability flag (`ai` → ai, `reminders` →
 * reminders, `location` → maps, `data` → importExport, `security` → vaultAdmin
 * — every Security tab is a vault-admin operation the web build cannot
 * perform).
 *
 * Shared by SettingsPanel (rail filter) and the command palette's
 * `settings.*` deep links so a hidden category can never be navigated to.
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
