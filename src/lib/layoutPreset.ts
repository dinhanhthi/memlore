/**
 * User-selectable app-layout union and the two derived booleans the
 * shell keys off. Leaf module with no store or React imports so the
 * settings hook, picker previews, and layout components share one
 * coercion + flag source of truth.
 */
export type LayoutPreset = 'sidebar-panel-main' | 'sidebar-main-panel' | 'main-panel-sidebar'

export const LAYOUT_PRESETS: readonly LayoutPreset[] = [
  'sidebar-panel-main',
  'sidebar-main-panel',
  'main-panel-sidebar',
]

export const DEFAULT_LAYOUT_PRESET: LayoutPreset = 'sidebar-panel-main'

export interface LayoutFlags {
  sidebarRight: boolean
  panelAfterMain: boolean
}

function isLayoutPreset(v: unknown): v is LayoutPreset {
  return typeof v === 'string' && (LAYOUT_PRESETS as readonly string[]).includes(v)
}

/** Anything not in `LAYOUT_PRESETS` falls back to the default (sidebar-panel-main). */
export function coerceLayoutPreset(v: unknown): LayoutPreset {
  return isLayoutPreset(v) ? v : DEFAULT_LAYOUT_PRESET
}

/**
 * Visual-order flags for a preset. `sidebarRight` is only
 * `main-panel-sidebar`; `panelAfterMain` is every preset except the
 * default `sidebar-panel-main`. Components key off these booleans,
 * never the preset string.
 */
export function layoutFlags(preset: LayoutPreset): LayoutFlags {
  return {
    sidebarRight: preset === 'main-panel-sidebar',
    panelAfterMain: preset !== 'sidebar-panel-main',
  }
}
