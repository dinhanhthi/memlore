import { useCallback } from 'react'
import { createSettingHook } from './createSettingHook'

const setting = createSettingHook({
  key: 'editor_mention_include_locked',
  defaultValue: false,
  parse: (raw) => raw === 'true' || raw === '1',
  logLabel: 'useMentionIncludeLocked',
})

/**
 * Read `editor_mention_include_locked` from SQLite. Called after DB unlock so
 * the setting reflects the real database, not the `:memory:` placeholder.
 */
export const hydrateMentionIncludeLocked = setting.hydrate

/** Whether the mention setting has been read from SQLite at least once. */
export const isMentionIncludeLockedHydrated = setting.isHydrated

export function useMentionIncludeLocked(): boolean {
  return setting.useValue()
}

/** True once `editor_mention_include_locked` has been read from SQLite (or hydration failed). */
export function useMentionIncludeLockedHydrated(): boolean {
  return setting.useHydrated()
}

/** Non-reactive read — for TipTap extension callbacks outside React. */
export const getMentionIncludeLocked = setting.get

/** Imperative setter — for command palette and non-React callers. */
export const setMentionIncludeLocked = setting.setValue

export function useMentionIncludeLockedSetting() {
  const includeLocked = useMentionIncludeLocked()

  const setIncludeLocked = useCallback((next: boolean) => setMentionIncludeLocked(next), [])

  return { includeLocked, setIncludeLocked, hydrated: isMentionIncludeLockedHydrated() }
}

/** Test-only: reset module state between cases. */
export const __resetMentionIncludeLockedForTests = setting.reset
