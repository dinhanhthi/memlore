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
 *
 * Outbox v2 drafts (journal, tag, template, trash; Phase 21) never reach the entry rules above.
 * Without `v2` (the capable set and the taxonomy) they are all kept, silently. A PUSHED one is
 * dropped when:
 *  - reflected in the synced state: the journal is in `journals/` (any state), the tag in
 *    `tags.bin` (live OR deleted: a tag the desktop created then deleted must still lift the
 *    push hold-back of the entry drafts naming it), the upserted template is live with the same
 *    content (a deleted one waits for the desktop's `changed_on_desktop` refusal), the deleted
 *    template is deleted, the trashed entry is trashed or tombstoned in a manifest. Silent;
 *  - acked by a v2-capable desktop (`resolveV2Ack`): applied silently, or finally refused with a
 *    `refused` notice whose `field` is the v2 kind. Capable = slot-holding desktops advertising
 *    `outbox_versions ∋ 2`; the others' acks are ignored (a v0.2.2 desktop acks a v2 file with
 *    every field null). The 7-day undecided grace applies as for entry intents.
 * While NO slot-holding desktop advertises v2, every v2 draft (pushed or not) is kept and raises
 * one `waiting_newer_desktop` notice (`field` = the v2 kind), once per draft.
 */

import type { Core, OutboxIntentV2 } from '../../core/core'
import type { Taxonomy, VaultApi } from '../commands/readSession'
import { sha256Hex } from '../drafts'
import type { KeyRing } from '../keys'
import {
  OUTBOX_BLOB_PREFIX,
  OUTBOX_META_PREFIX,
  OUTBOX_PUSHED_AT_PREFIX,
  draftKind,
  type DraftKind,
  type DraftRecord,
  type WebDb,
} from '../storage/idb'
import type { EntryMetadata } from '../vault'
import {
  ackIntentPath,
  decisionKey,
  formatNotice,
  resolveV2Ack,
  shouldRetainIntent,
  type FieldNotice,
  type OutboxAcksV1,
  type OutboxEntryV1,
  type OutboxFields,
  type WebNotice,
} from './outbox'
import { openV2Intent, v2IntentTarget } from './safeUpload'

export const UNDECIDED_GRACE_SECS = 7 * 86400

const RESOLVED = `${OUTBOX_META_PREFIX}resolved:`
const REFUSED_AT = `${OUTBOX_META_PREFIX}refused-at:`
const PUSHED_AT = OUTBOX_PUSHED_AT_PREFIX
const WAITING = `${OUTBOX_META_PREFIX}waiting:`
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

/** What the v2 rules read (see the header); the taxonomy is the synced one, never an overlay. */
export interface RetentionV2 {
  /** Slot-holding desktops advertising `outbox_versions ∋ 2` (`Puller.v2Desktops`). */
  desktops: ReadonlySet<string>
  taxonomy: Pick<Taxonomy, 'knownJournalIds' | 'knownTagIds' | 'templates' | 'deletedTemplateIds'>
}

export interface RetentionDeps {
  db: Pick<WebDb, 'drafts' | 'files' | 'meta' | 'device'>
  core: Pick<Core, 'openOutboxAcks' | 'openOutboxEntry' | 'openOutboxIntent'>
  ring: KeyRing
  /** Web clock, Unix seconds. */
  nowSecs: () => number
  desktops: RetentionDesktops
  vault: Pick<
    VaultApi,
    'load' | 'getSynced' | 'getOutboxIntent' | 'getOutboxIntents' | 'setOutboxIntents'
  >
  /** Absent: every v2 draft is kept, silently. */
  v2?: RetentionV2
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

/**
 * Every manifest device's acks (absent file: none). Throws when a present file does not open. An
 * entry that is not an object with a string `path` and a `decided` array is skipped: it decides
 * nothing, so its draft is kept (the field types are checked where they are read).
 */
async function readAcks(deps: RetentionDeps): Promise<Map<string, OutboxAcksV1>> {
  const out = new Map<string, OutboxAcksV1>()
  for (const device of deps.desktops.manifests) {
    const rec = await deps.db.files.get(`${device}/${ACKS_FILE}`)
    if (rec === undefined) continue
    const parsed: unknown = JSON.parse(deps.core.openOutboxAcks(deps.ring, rec.ciphertext))
    if (!isRecord(parsed) || !Array.isArray(parsed.acks)) throw new Error('acks file is malformed')
    const acks = (parsed.acks as unknown[]).filter(
      (a) => isRecord(a) && typeof a.path === 'string' && Array.isArray(a.decided),
    ) as OutboxAcksV1['acks']
    // Capability is about the folder it was read from, whatever id the file claims.
    out.set(device, { ...(parsed as unknown as OutboxAcksV1), acks, desktop_device_id: device })
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

  const entryDrafts = drafts.filter((d) => draftKind(d) === 'entry')
  const v2Drafts = drafts.filter((d) => draftKind(d) !== 'entry')
  const load =
    entryDrafts.length > 0
      ? await deps.vault.load(entryDrafts.map((d) => d.entryId))
      : { failed: [] }
  const failed = new Set(load.failed.map((f) => f.id))

  const opened = new Map(entryDrafts.map((d) => [d.entryId, openIntent(deps, d)]))

  const result: RetentionResult = { dropped: [], notices: [], changed: false }
  for (const draft of entryDrafts) {
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
  const v2Context = { webId: device.deviceId, acksByDevice, allAcks, slotDesktops }
  if (v2Drafts.length > 0) await retainV2(deps, v2Drafts, v2Context, result)
  return result
}

// ---------------------------------------------------------------------------------------------
// Outbox v2 drafts (Phase 21)
// ---------------------------------------------------------------------------------------------

const KIND_OF_PREFIX: Record<string, Exclude<DraftKind, 'entry'>> = {
  j: 'journal',
  t: 'tag',
  p: 'template',
  d: 'trash',
}

/** The draft's v2 intent, or null (kept) when it does not open or does not match its key. */
function openV2(deps: RetentionDeps, draft: DraftRecord): OutboxIntentV2 | null {
  try {
    const intent = openV2Intent(deps.core, deps.ring, draft.sealed)
    const { prefix, id } = v2IntentTarget(intent)
    const named = draft.entryId === `${prefix}-${id}` && draftKind(draft) === KIND_OF_PREFIX[prefix]
    return named ? intent : null
  } catch {
    return null
  }
}

function decodeBase64(b64: string): number[] | null {
  try {
    return Array.from(atob(b64), (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

function sameContent(a: readonly number[] | null, b: readonly number[] | null): boolean {
  if (a === null || b === null) return a === b
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/** The synced state already shows this intent (see the header). */
function isReflectedV2(
  intent: OutboxIntentV2,
  taxonomy: RetentionV2['taxonomy'],
  tombstones: ReadonlySet<string>,
): boolean {
  switch (intent.kind) {
    case 'create_journal':
      return taxonomy.knownJournalIds.includes(intent.journal_id)
    case 'create_tag':
      return taxonomy.knownTagIds.includes(intent.tag_id)
    case 'upsert_template': {
      // Only equal content counts: a deleted target is the desktop's `changed_on_desktop` refusal.
      const live = taxonomy.templates.find((t) => t.id === intent.template_id)
      if (live === undefined) return false
      const content = intent.content_b64 === null ? null : decodeBase64(intent.content_b64)
      if (intent.content_b64 !== null && content === null) return false
      return (
        live.name === intent.name &&
        (live.description ?? null) === intent.description &&
        live.sort_order === intent.sort_order &&
        sameContent(live.content, content)
      )
    }
    case 'delete_template':
      return taxonomy.deletedTemplateIds.includes(intent.template_id)
    case 'trash_entry':
      return tombstones.has(intent.entry_id)
  }
}

/** The name a notice shows, when the intent carries one. */
function titleOf(intent: OutboxIntentV2): string | undefined {
  return 'name' in intent && intent.name !== '' ? intent.name : undefined
}

async function forgetV2(deps: RetentionDeps, key: string): Promise<void> {
  await deps.db.meta.delete(`${PUSHED_AT}${key}`)
  await deps.db.meta.delete(`${WAITING}${key}`)
}

interface V2Context {
  webId: string
  acksByDevice: ReadonlyMap<string, OutboxAcksV1>
  allAcks: OutboxAcksV1[]
  slotDesktops: readonly string[]
}

async function retainV2(
  deps: RetentionDeps,
  drafts: readonly DraftRecord[],
  ctx: V2Context,
  result: RetentionResult,
): Promise<void> {
  const v2 = deps.v2
  if (v2 === undefined) return
  const capableAll = ctx.slotDesktops.filter((d) => v2.desktops.has(d))
  for (const draft of drafts) {
    const intent = openV2(deps, draft)
    if (intent === null) continue
    const key = draft.entryId
    const now = deps.nowSecs()
    const hash = await sha256Hex(draft.sealed)
    const since =
      draft.pushedHash === hash ? await deps.db.drafts.recordPushedAt(key, hash, now) : null
    if (draft.pushedHash === hash && since === null) continue // unmarked meanwhile: keep
    if (since !== null) {
      const capable = capableAll.filter(
        (d) => ctx.acksByDevice.has(d) || now - since < UNDECIDED_GRACE_SECS,
      )
      const outcome = isReflectedV2(intent, v2.taxonomy, deps.desktops.tombstones)
        ? ({ kind: 'applied' } as const)
        : resolveV2Ack({
            allAcks: ctx.allAcks,
            intentPath: ackIntentPath(ctx.webId, key),
            contentHash: hash,
            capableDesktops: capable,
          })
      if (outcome.kind !== 'pending') {
        if (await deps.db.drafts.dropPushed(key, draft.sealed, hash, [])) {
          await forgetV2(deps, key)
          result.dropped.push(key)
          result.changed = true
          if (outcome.kind === 'refused') {
            const title = titleOf(intent)
            result.notices.push(
              formatNotice('refused', { field: intent.kind, title, reason: outcome.reason }),
            )
          }
        }
        continue
      }
    }
    if (capableAll.length > 0) continue
    // Persist first, so the notice is never repeated.
    const waitingKey = `${WAITING}${key}`
    if ((await deps.db.meta.get(waitingKey)) !== undefined) continue
    await deps.db.meta.put({ key: waitingKey, value: true })
    result.notices.push(
      formatNotice('waiting_newer_desktop', { field: intent.kind, title: titleOf(intent) }),
    )
  }
}
