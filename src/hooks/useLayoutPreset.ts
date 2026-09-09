import {
  coerceLayoutPreset,
  DEFAULT_LAYOUT_PRESET,
  layoutFlags,
  type LayoutFlags,
  type LayoutPreset,
} from '../lib/layoutPreset'
import { createSettingHook } from './createSettingHook'

const setting = createSettingHook<LayoutPreset>({
  key: 'layout_preset',
  defaultValue: DEFAULT_LAYOUT_PRESET,
  parse: coerceLayoutPreset,
  logLabel: 'useLayoutPreset',
})

/**
 * Read `layout_preset` from SQLite. Called after DB unlock so the
 * setting reflects the real database, not the `:memory:` placeholder.
 */
export const hydrateLayoutPreset = setting.hydrate

export function useLayoutPreset(): LayoutPreset {
  return setting.useValue()
}

/** Derived shell flags. Components key off these booleans, never the preset string. */
export function useLayoutFlags(): LayoutFlags {
  return layoutFlags(setting.useValue())
}

export const getLayoutPreset = setting.get

/** Imperative setter — for settings UI and non-React callers. */
export const setLayoutPreset = setting.setValue

/** Test-only: reset module state between cases. */
export const __resetLayoutPresetForTests = setting.reset
