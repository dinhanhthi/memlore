import type { ComponentType } from 'react'
import type { LucideIcon } from 'lucide-react'

export type CommandGroup =
  | 'pages'
  | 'settings'
  | 'settings_values'
  | 'actions'
  | 'journals'
  | 'tags'

/**
 * One executable item in the Command Palette.
 *
 * - `id` is a stable identifier used for keys + tests. Format: `<group>.<slug>`.
 * - `labelKey` and `descriptionKey` are i18n keys in the `palette` namespace
 *   (e.g. `palette.page.entries`, `palette.action.new_entry`).
 * - `icon` is a component to render as the item's leading icon. Lucide icons
 *   (project rule: import directly from `lucide-react`, size with Tailwind
 *   `size-4`) or the canvas-based `AiIcon` — both accept a `className` prop.
 * - `keywords` are extra match tokens that complement the localized label
 *   (e.g. ['dark', 'night', 'theme'] for "Switch to dark theme").
 * - `shortcut` is an optional display string like `⌘K` shown on the right.
 * - `run` is invoked when the user selects the command.
 * - `available()` lets the registry hide a command based on current state
 *   (e.g. don't show "Switch to dark theme" when already in dark mode).
 */
export type Command = {
  id: string
  group: CommandGroup
  labelKey: string
  descriptionKey?: string
  icon: ComponentType<{ className?: string }> | LucideIcon
  keywords?: readonly string[]
  shortcut?: string
  run: () => void
  available?: () => boolean
}
