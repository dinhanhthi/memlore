/**
 * Global entry index built from every desktop's `metadata.json` manifest (READ-ONLY, pure).
 *
 * Winner per entry mirrors desktop `merge_metadata_lww` (memlore-core `metadata.rs`): the greater
 * `updated_at` (Unix SECONDS) wins; on an exact tie the greater authoring device id wins
 * (`remote.device_id > local.device_id`). The rule is symmetric, so manifest order never matters.
 * A tombstone is just a row with `is_deleted`: it wins or loses by the same rule, so an older live
 * copy on another device never resurrects a newer deletion.
 *
 * A trashed entry (desktop v0.3.0+) is published live (`is_deleted: false`) with a `trashed_at`
 * until it is purged. It is hidden like a tombstone, and on an exact `updated_at` tie the trashed
 * row wins BEFORE the device-id tiebreak: an older desktop that pulled the trashed payload re-lists
 * the entry as live at the same `updated_at`, which must not resurrect it here. (Desktop
 * `compute_diff` ties favour the local row instead; the web has no local row.)
 *
 * The manifest rows carry no full `EntryMetadata`, so the WASM `mergeMetadataLww` (which needs one)
 * cannot be used here; it applies later, to opened payloads (Phase 10.2).
 */

export interface ManifestEntryRow {
  entry_id: string
  updated_at: number
  is_deleted: boolean
  /** Set when the entry is in the desktop Trash (validated numeric, else absent). */
  trashed_at?: number
}

export interface IndexEntry {
  entryId: string
  /** The device folder whose manifest row won. */
  authorDevice: string
  updatedAt: number
  isDeleted: boolean
  /** The winner row's `trashed_at`: the entry is in the desktop Trash and hidden like a tombstone. */
  trashedAt?: number
}

export type EntryIndex = ReadonlyMap<string, IndexEntry>

export interface DeviceRows {
  device: string
  entries: readonly ManifestEntryRow[]
}

/**
 * The LWW winner of two rows for the same entry (desktop `merge_metadata_lww` tie-breaks), except
 * that a trashed row wins an exact `updated_at` tie (see the module comment).
 */
export function lwwWinner(a: IndexEntry, b: IndexEntry): IndexEntry {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b
  const aTrashed = a.trashedAt !== undefined
  if (aTrashed !== (b.trashedAt !== undefined)) return aTrashed ? a : b
  return b.authorDevice > a.authorDevice ? b : a
}

export function buildEntryIndex(devices: Iterable<DeviceRows>): Map<string, IndexEntry> {
  const index = new Map<string, IndexEntry>()
  for (const { device, entries } of devices) {
    for (const row of entries) {
      const candidate: IndexEntry = {
        entryId: row.entry_id,
        authorDevice: device,
        updatedAt: row.updated_at,
        isDeleted: row.is_deleted,
        ...(typeof row.trashed_at === 'number' ? { trashedAt: row.trashed_at } : {}),
      }
      const current = index.get(row.entry_id)
      index.set(row.entry_id, current === undefined ? candidate : lwwWinner(current, candidate))
    }
  }
  return index
}

/**
 * The `limit` newest live (neither deleted nor trashed) entries: `updated_at` descending, then entry id ascending
 * (desktop `sort_to_pull_newest_first`), so the choice is deterministic on ties.
 */
export function newestLive(index: EntryIndex, limit: number): IndexEntry[] {
  return [...index.values()]
    .filter(isLive)
    .sort((a, b) => b.updatedAt - a.updatedAt || (a.entryId < b.entryId ? -1 : 1))
    .slice(0, Math.max(0, limit))
}

/** Neither a tombstone nor in the desktop Trash. */
export function isLive(entry: IndexEntry): boolean {
  return !entry.isDeleted && entry.trashedAt === undefined
}
