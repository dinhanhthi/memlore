import type { ActiveView } from '../stores/uiStore'
import type { Tab } from '../stores/tabStore'
import type { Journal } from '../types/journal'
import type { Entry } from '../types/entry'

/**
 * Human-readable label for a nav view (used in tab titles).
 */
export function labelForView(view: ActiveView): string {
  switch (view) {
    case 'dashboard':
      return 'Home'
    case 'entries':
      return 'Entries'
    case 'tags':
      return 'Tags'
    case 'calendar':
      return 'Calendar'
    case 'search':
      return 'Search'
    // 'templates' is no longer an ActiveView — it lives under Settings.
    case 'settings':
      return 'Settings'
    case 'onthisday':
      return 'On This Day'
    case 'media':
      return 'Media Gallery'
    case 'map':
      return 'Locations Map'
    case 'stats':
      return 'Statistics'
    case 'chat':
      return 'Daily Chat'
    case 'about':
      return 'About'
    default: {
      // Exhaustive check — TypeScript will catch any missing cases
      const _exhaustive: never = view
      return String(_exhaustive)
    }
  }
}

/**
 * Derives the title to display for a tab.
 *
 * Rules:
 *   - entries + entry selected: entry title (or "Untitled")
 *   - Otherwise: view label (e.g. "Entries", "Calendar", "Settings")
 */
export function titleForTab(tab: Tab, _journal: Journal | null, entry: Entry | null): string {
  if (tab.activeView === 'entries' && entry) {
    return entry.title || 'Untitled'
  }
  return labelForView(tab.activeView)
}
