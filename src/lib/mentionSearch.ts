import { getMentionIncludeLocked } from '../hooks/useMentionIncludeLocked'
import { useInvisibleLockStore } from '../stores/invisibleLockStore'
import { useSecondLockStore } from '../stores/secondLockStore'
import type { SearchResult } from '../types/entry'
import { i18n } from './i18n'
import { searchEntries, type LockedView } from './tauri'

/** Max rows the `@` menu shows. */
const MAX_CANDIDATES = 8

export interface MentionCandidate {
  id: string
  label: string
  journalId: string
  preview: string | null
  entryDate: number
}

function toCandidate(result: SearchResult): MentionCandidate {
  return {
    id: result.id,
    label: result.title?.trim() || i18n.t('mention.untitled', { ns: 'editor' }),
    journalId: result.journal_id,
    preview: result.preview_text,
    entryDate: result.entry_date,
  }
}

/**
 * The effective lock parameters every mention search runs under, plus a
 * `signature` that changes whenever they do.
 *
 * Candidates fetched under one signature must not be inserted under another:
 * an auto-lock can re-engage while the menu sits open (see
 * `useSecondLockAutoLock`), and inserting then would write a now-protected
 * title into a plain entry's text.
 */
export function mentionLockContext(): {
  lockedView: LockedView
  activeVaultId: string | null
  signature: string
} {
  const includeLocked = getMentionIncludeLocked()
  const lockedView: LockedView = includeLocked
    ? useSecondLockStore.getState().lockedView()
    : 'hidden'
  const activeVaultId = includeLocked ? useInvisibleLockStore.getState().activeVaultId : null
  // Effective values only: with the setting off the signature is constant, so
  // toggling a lock cannot block results that were already fetched as hidden.
  return { lockedView, activeVaultId, signature: `${lockedView}|${activeVaultId ?? ''}` }
}

/**
 * Entries offered by the `@` menu. Runs outside React (TipTap's
 * `Suggestion.items`), so stores are read via `getState()`.
 *
 * Privacy gate: with `editor_mention_include_locked` off (the default) the
 * backend is asked for `lockedView: 'hidden'` / `activeVaultId: null`
 * regardless of what the user has unlocked, so its SQL predicates drop every
 * second-locked and vault entry — no protected title can reach a `label`.
 * With the setting on, the real lock state is forwarded and already-unlocked
 * entries become mentionable (the exposure the setting's warning describes).
 */
export async function searchMentionCandidates(
  query: string,
  opts: { excludeEntryId?: string | null },
): Promise<MentionCandidate[]> {
  const trimmed = query.trim()
  if (!trimmed) return []

  const { lockedView, activeVaultId } = mentionLockContext()

  const results = await searchEntries(trimmed, undefined, lockedView, activeVaultId, true)
  return results
    .filter((result) => result.id !== opts.excludeEntryId)
    .slice(0, MAX_CANDIDATES)
    .map(toCandidate)
}

/**
 * Monotonic sequence guard: only the newest request may commit its results,
 * so a slow response for an earlier query cannot overwrite newer ones.
 */
export function createRequestGuard() {
  let latest = 0
  return {
    next: () => ++latest,
    isCurrent: (seq: number) => seq === latest,
  }
}
