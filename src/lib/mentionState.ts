import type { Entry } from '../types/entry'
import type { LockedView } from './tauri'

/**
 * Display state for an inline `mention` node. `label` is only the snapshot of
 * the title taken at insert time — the entry store is the source of truth, so a
 * live rename wins and `label` is the fallback when the entry is untitled or
 * not loaded yet. `unavailable` with an empty title means the caller renders
 * the `mention.unavailable` i18n string.
 */
export function mentionDisplay(input: {
  entry: Entry | null | undefined
  label: string
  lockedView: LockedView
  activeVaultId: string | null
}): { title: string; unavailable: boolean } {
  const { entry, label, lockedView, activeVaultId } = input
  if (entry === undefined) return { title: label, unavailable: false }
  if (entry === null) return { title: '', unavailable: true }
  // `get_entry_impl` gates only on vault visibility and never on the second
  // lock; and `entriesById` is a session-long accumulating cache that
  // `lockSession()` never purges, so a cached row skips the fetch path and even
  // the vault gate is missed. Both are re-applied here on every render. Checked
  // before `is_deleted` so a trashed entry that is also protected does not
  // surface its title through the trash path.
  if (entry.is_locked && lockedView !== 'revealed') return { title: '', unavailable: true }
  if (entry.is_invisible && entry.vault_id !== activeVaultId)
    return { title: '', unavailable: true }
  if (entry.is_deleted) return { title: entry.title ?? label, unavailable: true }
  return { title: entry.title?.trim() || label, unavailable: false }
}
