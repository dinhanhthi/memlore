import { useCallback } from 'react'
import { createSettingHook } from './createSettingHook'

const setting = createSettingHook({
  key: 'editor_emoji_shortcodes_enabled',
  defaultValue: false,
  parse: (raw) => raw === 'true' || raw === '1',
  logLabel: 'useEditorEmojiShortcodesEnabled',
})

/**
 * Read `editor_emoji_shortcodes_enabled` from SQLite. Called after DB unlock so
 * the setting reflects the real database, not the `:memory:` placeholder.
 */
export const hydrateEditorEmojiShortcodesEnabled = setting.hydrate

/** Whether the emoji-shortcode setting has been read from SQLite at least once. */
export const isEditorEmojiShortcodesHydrated = setting.isHydrated

export function useEditorEmojiShortcodesEnabled(): boolean {
  return setting.useValue()
}

/** True once `editor_emoji_shortcodes_enabled` has been read from SQLite (or hydration failed). */
export function useEditorEmojiShortcodesHydrated(): boolean {
  return setting.useHydrated()
}

/** Non-reactive read — for TipTap extension callbacks outside React. */
export const getEditorEmojiShortcodesEnabled = setting.get

/** Imperative setter — for command palette and non-React callers. */
export const setEditorEmojiShortcodesEnabled = setting.setValue

export function useEditorEmojiShortcodesSetting() {
  const emojiShortcodesEnabled = useEditorEmojiShortcodesEnabled()

  const setEmojiShortcodesEnabled = useCallback(
    (next: boolean) => setEditorEmojiShortcodesEnabled(next),
    [],
  )

  return {
    emojiShortcodesEnabled,
    setEmojiShortcodesEnabled,
    hydrated: isEditorEmojiShortcodesHydrated(),
  }
}

/** Test-only: reset module state between cases. */
export const __resetEditorEmojiShortcodesEnabledForTests = setting.reset
