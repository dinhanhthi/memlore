/**
 * Intent retention (Phase 16.1 rules, wired in Phase 16.6.8).
 *
 * After every read-session pull, and once after the drafts hydrate the overlay, every draft is
 * evaluated against the synced state (the vault's synced copy, never the overlay; tombstones of
 * every manifest), every desktop's cached `outbox-acks.bin`, and the importer-capable desktops:
 *  - a PUSHED draft no longer needed (`shouldRetainIntent`) is deleted with its `outbox/m-<id>`
 *    media and leaves the overlay. An unpushed draft is never deleted: its newest bytes are not on
 *    Drive;
 *  - resolved fields leave the overlay intent at once, so the synced value shows. The stored draft
 *    keeps them until the next rewrite, which builds on the overlay intent (`priorIntent`), so they
 *    are omitted then: resolving alone causes no upload;
 *  - each "replaced" / "refused" notice (a structured `WebNotice`, translated by the UI) is
 *    returned once.
 *
 * Importer-capable desktop: a device with a slot (`.meta/keyring/devices/<id>.json`) AND a manifest
 * that has an `outbox-acks.bin`. A slot holder with a manifest but no acks file yet counts as
 * UNDECIDED for 7 days after the intent revision was first seen pushed, then is ignored.
 *
 * Clocks: only the web's own clock (`nowSecs`, Drive `Date`-corrected) times the 7-day and 30-day
 * bounds, from first-seen times persisted in IndexedDB `meta` (`outbox-` keys, kept with the drafts
 * by `clearCache`). Desktop-stamped values are only compared with each other (`outbox.ts`).
 *
 * Fail safe: any read error (an unknown slot list, an acks file that does not open, a missing
 * device record) keeps every draft and shows nothing; a synced payload that cannot be read keeps
 * that draft.
 */

import type { Core } from '../../core/core'
import type { VaultApi } from '../commands/readSession'
import { sha256Hex } from '../drafts'
import type { KeyRing } from '../keys'
import {
  OUTBOX_BLOB_PREFIX,
  OUTBOX_META_PREFIX,
  OUTBOX_PUSHED_AT_PREFIX,
  type DraftRecord,
  type WebDb,
} from '../storage/idb'
import type { EntryMetadata } from '../vault'
import {
  ackIntentPath,
  decisionKey,
  shouldRetainIntent,
  type FieldNotice,
  type OutboxAcksV1,
  type OutboxEntryV1,
  type OutboxFields,
  type WebNotice,
} from './outbox'

export const UNDECIDED_GRACE_SECS = 7 * 86400

const RESOLVED = `${OUTBOX_META_PREFIX}resolved:`
const REFUSED_AT = `${OUTBOX_META_PREFIX}refused-at:`
const PUSHED_AT = OUTBOX_PUSHED_AT_PREFIX
const ACKS_FILE = 'outbox-acks.bin'

/** What the last pull saw of the other devices. */
export interface RetentionDesktops {
  /** Devices with a manifest (desktops). */
  manifests: readonly string[]
  /** Device slot ids; null when the slot list is unknown (keep everything). */
  slots: ReadonlySet<string> | null
  /** Entry ids with a tombstone row in ANY manifest. */
  tombstones: ReadonlySet<string>
}

export interface RetentionDeps {
  db: Pick<WebDb, 'drafts' | 'files' | 'meta' | 'device'>
  core: Pick<Core, 'openOutboxAcks' | 'openOutboxEntry'>
  ring: KeyRing
  /** Web clock, Unix seconds. */
  nowSecs: () => number
  desktops: RetentionDesktops
  vault: Pick<
    VaultApi,
    'load' | 'getSynced' | 'getOutboxIntent' | 'getOutboxIntents' | 'setOutboxIntents'
  >
}

export interface RetentionResult {
  dropped: string[]
  /** New notices, oldest first; each is persisted as shown before it is returned. */
  notices: WebNotice[]
  /** The overlay changed (a draft dropped or a field hidden). */
  changed: boolean
}

const NOTHING: RetentionResult = { dropped: [], notices: [], changed: false }

/** The UI's view of a field notice: its decision identity (`change_seq`) stays here. */
function toWebNotice({ change_seq: _seq, ...notice }: FieldNotice): WebNotice {
  return notice
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Every manifest device's acks (absent file: none). Throws when a present file does not open. */
async function readAcks(deps: RetentionDeps): Promise<Map<string, OutboxAcksV1>> {
  const out = new Map<string, OutboxAcksV1>()
  for (const device of deps.desktops.manifests) {
    const rec = await deps.db.files.get(`${device}/${ACKS_FILE}`)
    if (rec === undefined) continue
    const parsed: unknown = JSON.parse(deps.core.openOutboxAcks(deps.ring, rec.ciphertext))
    if (!isRecord(parsed) || !Array.isArray(parsed.acks)) throw new Error('acks file is malformed')
    // Capability is about the folder it was read from, whatever id the file claims.
    out.set(device, { ...(parsed as unknown as OutboxAcksV1), desktop_device_id: device })
  }
  return out
}

function openIntent(deps: RetentionDeps, draft: DraftRecord): OutboxEntryV1 | null {
  try {
    const parsed: unknown = JSON.parse(deps.core.openOutboxEntry(deps.ring, draft.sealed))
    if (!isRecord(parsed) || parsed.entry_id !== draft.entryId || !isRecord(parsed.fields)) {
      return null
    }
    return parsed as unknown as OutboxEntryV1
  } catch {
    return null // hydration already logged it; it is kept
  }
}

/** JSON with sorted keys: the same intent opened from bytes or built by a write compares equal. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    isRecord(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v,
  )
}

/** `<field>@<seq>` -> web-clock seconds of the first refusal seen (recorded now when new). */
async function refusalTimes(
  deps: RetentionDeps,
  entryId: string,
  path: string,
  acks: OutboxAcksV1[],
  now: number,
): Promise<Map<string, number>> {
  const times = new Map<string, number>()
  for (const file of acks) {
    for (const a of file.acks) {
      if (a.path !== path) continue
      for (const d of a.decided) {
        const k = decisionKey(d.field, d.change_seq)
        if (d.decision !== 'refused' || times.has(k)) continue
        const key = `${REFUSED_AT}${entryId}:${k}`
        const value = (await deps.db.meta.get(key))?.value
        if (typeof value === 'number') times.set(k, value)
        else {
          await deps.db.meta.put({ key, value: now })
          times.set(k, now)
        }
      }
    }
  }
  return times
}

async function resolvedKeys(deps: RetentionDeps, entryId: string): Promise<Set<string>> {
  const prefix = `${RESOLVED}${entryId}:`
  const records = await deps.db.meta.listByPrefix(prefix)
  return new Set(records.map((r) => r.key.slice(prefix.length)))
}

async function forgetEntry(deps: RetentionDeps, entryId: string): Promise<void> {
  for (const prefix of [`${RESOLVED}${entryId}:`, `${REFUSED_AT}${entryId}:`]) {
    for (const r of await deps.db.meta.listByPrefix(prefix)) await deps.db.meta.delete(r.key)
  }
  await deps.db.meta.delete(`${PUSHED_AT}${entryId}`)
}

function withoutKeys(fields: OutboxFields, keys: ReadonlySet<string>): OutboxFields {
  const keep = <T extends { change_seq: number } | null>(name: string, c: T): T | null =>
    c !== null && keys.has(decisionKey(name, c.change_seq)) ? null : c
  const tags = (prefix: string, map: OutboxFields['tags_add']): OutboxFields['tags_add'] =>
    Object.fromEntries(Object.entries(map).filter(([id, c]) => keep(`${prefix}:${id}`, c) !== null))
  return {
    title: keep('title', fields.title),
    entry_date: keep('entry_date', fields.entry_date),
    emotion: keep('emotion', fields.emotion),
    is_favorite: keep('is_favorite', fields.is_favorite),
    journal_id: keep('journal_id', fields.journal_id),
    tags_add: tags('tag_add', fields.tags_add),
    tags_remove: tags('tag_remove', fields.tags_remove),
  }
}

/** Replaces (or removes) the overlay intent, only while it is still this draft's revision. */
function updateOverlay(
  deps: RetentionDeps,
  draftIntent: OutboxEntryV1,
  known: ReadonlySet<string>,
  next: OutboxEntryV1 | null,
): boolean {
  const current = deps.vault.getOutboxIntent(draftIntent.entry_id)
  if (current === undefined) return false
  const seen = canonical(current)
  const fresh = canonical(draftIntent)
  const cleaned = canonical({ ...draftIntent, fields: withoutKeys(draftIntent.fields, known) })
  if (seen !== fresh && seen !== cleaned) return false // a write set a newer revision meanwhile
  if (next !== null && canonical(next) === seen) return false
  const others = deps.vault.getOutboxIntents().filter((i) => i.entry_id !== draftIntent.entry_id)
  deps.vault.setOutboxIntents(next === null ? others : [...others, next])
  return true
}

function mediaPaths(media: OutboxEntryV1['media']): string[] {
  return media.flatMap((m) => [
    `${OUTBOX_BLOB_PREFIX}m-${m.media_id}`,
    `${OUTBOX_BLOB_PREFIX}m-${m.media_id}.thumb`,
  ])
}

/** One pass over every draft. Never rejects for a read error: it keeps everything instead. */
export async function runRetention(deps: RetentionDeps): Promise<RetentionResult> {
  const { desktops } = deps
  if (desktops.slots === null) return NOTHING
  const device = await deps.db.device.get()
  const drafts = await deps.db.drafts.list()
  if (device === undefined || drafts.length === 0) return NOTHING

  let acksByDevice: Map<string, OutboxAcksV1>
  try {
    acksByDevice = await readAcks(deps)
  } catch {
    return NOTHING
  }
  const allAcks = [...acksByDevice.values()]
  const slots = desktops.slots
  const slotDesktops = desktops.manifests.filter((d) => slots.has(d))

  const load = await deps.vault.load(drafts.map((d) => d.entryId))
  const failed = new Set(load.failed.map((f) => f.id))

  const opened = new Map(drafts.map((d) => [d.entryId, openIntent(deps, d)]))

  const result: RetentionResult = { dropped: [], notices: [], changed: false }
  for (const draft of drafts) {
    const id = draft.entryId
    const intent = opened.get(id) ?? null
    if (intent === null || failed.has(id)) continue
    const synced = deps.vault.getSynced(id)
    if (synced.status === 'journal') continue // its metadata is hidden: cannot tell, keep
    const now = deps.nowSecs()
    const hash = await sha256Hex(draft.sealed)
    const since =
      draft.pushedHash === hash ? await deps.db.drafts.recordPushedAt(id, hash, now) : null
    // Read as pushed but unmarked meanwhile (a re-onboard's `clearPushed`): keep it, say nothing.
    if (draft.pushedHash === hash && since === null) continue
    const pushed = since !== null
    const capable = slotDesktops.filter(
      (d) => acksByDevice.has(d) || since === null || now - since < UNDECIDED_GRACE_SECS,
    )
    const path = ackIntentPath(device.deviceId, id)
    const known = await resolvedKeys(deps, id)
    const syncedEntry: EntryMetadata | null = synced.metadata
    const res = shouldRetainIntent({
      intent,
      intentPath: path,
      contentHash: pushed ? hash : null,
      syncedEntry,
      syncedContent: synced.content,
      tombstoned: desktops.tombstones.has(id),
      allAcks,
      capableDesktops: capable,
      firstRefusalTimes: await refusalTimes(deps, id, path, allAcks, now),
      resolvedKeys: known,
      nowSecs: now,
    })

    if (!res.retain && pushed) {
      // Defense in depth: never delete media another stored draft still references.
      // (A draft that does not open is kept, but its references are unknown.)
      const shared = new Set(
        [...opened].flatMap(([other, i]) => (other === id ? [] : mediaPaths(i?.media ?? []))),
      )
      const blobs = mediaPaths(intent.media).filter((p) => !shared.has(p))
      if (await deps.db.drafts.dropPushed(id, draft.sealed, hash, blobs)) {
        opened.delete(id)
        await forgetEntry(deps, id)
        updateOverlay(deps, intent, known, null)
        result.dropped.push(id)
        result.changed = true
        if (res.notice !== undefined) result.notices.push(res.notice)
        for (const n of res.fieldNotices) result.notices.push(toWebNotice(n))
      }
      continue
    }

    // Persist first, so a notice is never repeated (a reload between the two loses it instead).
    for (const k of res.resolvedKeys)
      await deps.db.meta.put({ key: `${RESOLVED}${id}:${k}`, value: true })
    for (const n of res.fieldNotices) result.notices.push(toWebNotice(n))
    const all = new Set([...known, ...res.resolvedKeys])
    if (all.size > 0) {
      const next = { ...intent, fields: withoutKeys(intent.fields, all) }
      if (updateOverlay(deps, intent, known, next)) result.changed = true
    }
  }
  return result
}
