import { errMsg } from './errMsg'

/** Desktop write commands reject this for an entry in Trash
 * (`LiveEntryError::Trashed` in `src-tauri/src/db/queries.rs`). */
const TRASHED_ENTRY_MESSAGE = 'entry is in Trash; restore it to edit'

/** True when a save/snapshot failed only because the entry is in Trash — the
 * editor stops quietly instead of showing an error. */
export function isTrashedEntryError(err: unknown): boolean {
  return errMsg(err).includes(TRASHED_ENTRY_MESSAGE)
}

type TrashFields = { is_deleted: boolean; trashed_at?: number | null }

/** In Trash only when both fields agree: a live row with a stale `trashed_at`
 * (left by an older build after a downgrade) is writable, matching
 * `require_live_entry` in `src-tauri/src/db/queries.rs`. */
export function isEntryInTrash(entry: TrashFields): boolean {
  return entry.is_deleted && entry.trashed_at != null
}

/** After an entry refetch: re-save the in-memory doc only when a write was
 * rejected as trashed and the entry is now live again (restored), so text
 * typed before the rejection is not dropped. Keyed on `is_deleted` alone: a
 * purged tombstone (`is_deleted`, no `trashed_at`) is gone for good, while a
 * live row with a stale `trashed_at` (downgrade) is writable. */
export function shouldResaveAfterRestore(trashRejected: boolean, entry: TrashFields): boolean {
  return trashRejected && !entry.is_deleted
}
