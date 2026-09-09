/**
 * Payload for `memlore:restore-entry-version`. `EditorPanel` listens for
 * this event and performs a CRDT-safe restore: it never overwrites the
 * `yjs_doc` blob directly — instead it fetches the version's content,
 * converts it to TipTap JSON, and applies it via the live editor's
 * `setContent(json, { emitUpdate: true })` so Yjs records delete+insert
 * ops. This is what makes the restore correctly merge (rather than
 * clobber) state on other devices, since entry sync is a CRDT union.
 */
export interface RestoreEntryVersionDetail {
  entryId: string
  versionId: string
}

export function emitRestoreEntryVersion(entryId: string, versionId: string): void {
  window.dispatchEvent(
    new CustomEvent<RestoreEntryVersionDetail>('memlore:restore-entry-version', {
      detail: { entryId, versionId },
    }),
  )
}

/**
 * Broadcast that a new version was captured (or pruned) for `entryId`.
 * `useEntryVersions` listens for this to invalidate its cached list —
 * without it, the version-list modal could show a stale list for up to
 * `staleTime` after a session-snapshot fires from `EditorPanel`.
 */
export interface EntryVersionsChangedDetail {
  entryId: string
}

export function emitEntryVersionsChanged(entryId: string): void {
  window.dispatchEvent(
    new CustomEvent<EntryVersionsChangedDetail>('memlore:entry-versions-changed', {
      detail: { entryId },
    }),
  )
}
