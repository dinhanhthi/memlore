/**
 * Global entry index built from every desktop's `metadata.json` manifest (READ-ONLY, pure).
 *
 * Winner per entry mirrors desktop `merge_metadata_lww` (memlore-core `metadata.rs`): the greater
 * `updated_at` (Unix SECONDS) wins; on an exact tie the greater authoring device id wins
 * (`remote.device_id > local.device_id`). The rule is symmetric, so manifest order never matters.
 * A tombstone is just a row with `is_deleted`: it wins or loses by the same rule, so an older live
 * copy on another device never resurrects a newer deletion.
 *
 * The manifest rows carry no full `EntryMetadata`, so the WASM `mergeMetadataLww` (which needs one)
 * cannot be used here; it applies later, to opened payloads (Phase 10.2).
 */

export interface ManifestEntryRow {
  entry_id: string
  updated_at: number
  is_deleted: boolean
}

export interface IndexEntry {
  entryId: string
  /** The device folder whose manifest row won. */
  authorDevice: string
  updatedAt: number
  isDeleted: boolean
}

export type EntryIndex = ReadonlyMap<string, IndexEntry>

export interface DeviceRows {
  device: string
  entries: readonly ManifestEntryRow[]
}

/** The LWW winner of two rows for the same entry (desktop `merge_metadata_lww` tie-breaks). */
export function lwwWinner(a: IndexEntry, b: IndexEntry): IndexEntry {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b
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
      }
      const current = index.get(row.entry_id)
      index.set(row.entry_id, current === undefined ? candidate : lwwWinner(current, candidate))
    }
  }
  return index
}

/**
 * The `limit` newest non-deleted entries: `updated_at` descending, then entry id ascending
 * (desktop `sort_to_pull_newest_first`), so the choice is deterministic on ties.
 */
export function newestLive(index: EntryIndex, limit: number): IndexEntry[] {
  return [...index.values()]
    .filter((entry) => !entry.isDeleted)
    .sort((a, b) => b.updatedAt - a.updatedAt || (a.entryId < b.entryId ? -1 : 1))
    .slice(0, Math.max(0, limit))
}
