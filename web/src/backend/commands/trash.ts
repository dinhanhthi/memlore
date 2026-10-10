/**
 * Read-only Trash list (`list_trashed_entries`) for the web companion.
 *
 * Two sources, merged and ordered as the desktop does (`ORDER BY trashed_at DESC, id`):
 *   1. Desktop Trash: index winners with `trashedAt` (`vault.listTrashedIndex`), decrypted on demand
 *      by `vault.loadTrashed` into a map apart from the live views. `trashed_at` comes from the copy
 *      (the index winner's when the payload lacks it).
 *   2. Pending web deletes: the `d-<entryId>` trash drafts of this browser. `trashed_at` is the
 *      local request time (`DraftRecord.updatedAt`, plaintext ms), `trash_pending_desktop` is set.
 *      An id that is also in the desktop Trash is shown once, as the desktop row.
 *
 * VISIBILITY: locked, invisible and journal-excluded entries are never listed (second lock is not
 * supported on the web), so `lockedView` and `activeVaultId` are ignored. A pending id the vault
 * cannot show after one `vault.load` is listed as an untitled row only when nothing synced is
 * known about it (`getSynced` status `'not-loaded'`: no index winner or an unreadable payload, and
 * no create intent). Any other status means it is excluded (locked, invisible, journal) or purged
 * on the desktop (`'deleted'`), and it is left out.
 */

import type { Entry } from '../../../../src/types/entry'
import type { TrashView } from '../vault'
import type { Handler } from '../router'
import { draftKind, draftTargetId } from '../storage/idb'
import { emotionOrNull, numOrNull, strOrNull } from './entryFields'
import { openForRead, readEnv } from './readSession'

/**
 * Desktop `Entry` of a Trash row. `trashed_at` defaults to the view's (null for a pending web
 * delete, whose request time only the draft knows). Never built through `toEntry`: that one marks
 * everything served as live.
 */
export function toTrashedEntry(view: TrashView, extra: { trashedAt?: number } = {}): Entry {
  const m = view.held.metadata
  return {
    id: m.entry_id,
    journal_id: m.journal_id,
    title: m.title,
    preview_text: m.preview_text,
    content_text: m.content_text,
    entry_date: m.entry_date,
    created_at: m.created_at,
    updated_at: m.updated_at,
    latitude: numOrNull(m.latitude),
    longitude: numOrNull(m.longitude),
    location_label: strOrNull(m.location_label),
    location_address: strOrNull(m.location_address),
    weather_summary: strOrNull(m.weather_summary),
    weather_icon: strOrNull(m.weather_icon),
    emotion: emotionOrNull(m.emotion),
    is_favorite: m.is_favorite,
    is_deleted: true,
    is_locked: false,
    is_invisible: false,
    vault_id: null,
    cover_media_id: strOrNull(m.cover_media_id),
    content_language: strOrNull(m.content_language),
    entry_date_user_edited: m.entry_date_user_edited === true,
    media_count: Array.isArray(m.media) ? m.media.length : 0,
    from_chat: false,
    trashed_at: extra.trashedAt ?? view.trashedAt,
    ...(view.pending ? { trash_pending_desktop: true } : {}),
  }
}

/** A pending web delete with nothing to show: the UI renders it "Untitled", not previewable. */
function untitledPendingEntry(id: string, trashedAt: number): Entry {
  return {
    id,
    journal_id: '',
    title: null,
    preview_text: null,
    content_text: null,
    entry_date: trashedAt,
    created_at: trashedAt,
    updated_at: trashedAt,
    latitude: null,
    longitude: null,
    location_label: null,
    location_address: null,
    weather_summary: null,
    weather_icon: null,
    emotion: null,
    is_favorite: false,
    is_deleted: true,
    is_locked: false,
    is_invisible: false,
    vault_id: null,
    cover_media_id: null,
    content_language: null,
    entry_date_user_edited: false,
    media_count: 0,
    from_chat: false,
    trashed_at: trashedAt,
    trash_pending_desktop: true,
  }
}

const byTrashedDesc = (a: Entry, b: Entry): number =>
  (b.trashed_at ?? 0) - (a.trashed_at ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

const listTrashedEntries: Handler = async () => {
  const { vault } = await openForRead()
  const { db } = await readEnv().session()

  const desktopIds = new Set(vault.listTrashedIndex().map((w) => w.entryId))
  await vault.loadTrashed([...desktopIds])
  const rows: Entry[] = []
  for (const id of desktopIds) {
    const view = vault.trashView(id)
    if (view !== null) rows.push(toTrashedEntry(view))
  }

  // Request time (unix seconds) per pending id, minus the ids the desktop already shows.
  const pending = new Map<string, number>()
  for (const draft of (await db?.drafts.list()) ?? []) {
    if (draftKind(draft) !== 'trash') continue
    const id = draftTargetId(draft)
    if (!desktopIds.has(id)) pending.set(id, Math.floor(draft.updatedAt / 1000))
  }
  const notInRam = [...pending.keys()].filter((id) => vault.trashView(id) === null)
  if (notInRam.length > 0) await vault.load(notInRam)
  for (const [id, trashedAt] of pending) {
    const view = vault.trashView(id)
    if (view !== null) rows.push(toTrashedEntry(view, { trashedAt }))
    else if (
      vault.getSynced(id).status === 'not-loaded' &&
      vault.getOutboxIntent(id)?.created_on_web !== true
    ) {
      rows.push(untitledPendingEntry(id, trashedAt))
    }
  }
  return rows.sort(byTrashedDesc)
}

export const trashHandlers: Record<string, Handler> = {
  list_trashed_entries: listTrashedEntries,
}
