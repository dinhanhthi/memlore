/**
 * Outbox Writer & Field Resolution (Phase 16.1).
 *
 * Implements the outbox model for web companion writes:
 *  - ONE intent per entry: `generations/g-<localGen>/<webDeviceId>/outbox/<entryId>.bin`
 *  - Yjs full state merge (synced base doc + prior intent + local edit)
 *  - Field accumulation across edits with monotonic change_seq
 *  - Precise two-desktop ordering and ack resolution rules
 *  - Upload ordering: media and thumbnails strictly precede entry intent
 *  - Retention and re-push checks
 */

import * as Y from 'yjs'
import type { EntryMetadata } from '../vault'
import { isOutboxIntentPath, type SafeUploadIntent } from './safeUpload'

export interface FieldChange<T> {
  value: T
  base: T
  base_updated_at: number
  change_seq: number
  changed_at_secs: number
}

export interface OutboxFields {
  title: FieldChange<string> | null
  entry_date: FieldChange<string> | null
  emotion: FieldChange<string | null> | null
  is_favorite: FieldChange<boolean> | null
  journal_id: FieldChange<string> | null
  tags_add: Record<string, FieldChange<boolean>>
  tags_remove: Record<string, FieldChange<boolean>>
}

export interface OutboxMediaRef {
  media_id: string
  file_name: string
  file_type: string
  size: number
  has_thumb: boolean
}

export interface OutboxEntryV1 {
  schema_version: 1
  entry_id: string
  web_device_id: string
  created_on_web: boolean
  web_updated_at_secs: number
  base_state_vector: number[]
  yjs_full_state: number[]
  content_text: string | null
  preview_text: string | null
  fields: OutboxFields
  media: OutboxMediaRef[]
}

export interface OutboxFieldDecision {
  field: string
  change_seq: number
  decision: string // 'applied' | 'reflected' | 'refused'
  decided_updated_at: number
  reason: string | null
}

export interface OutboxAckEntry {
  path: string
  content_hash: string
  applied_updated_at: number | null
  decided: OutboxFieldDecision[]
  created: boolean
  refused_reason: string | null
}

export interface OutboxAcksV1 {
  schema_version: number
  desktop_device_id: string
  acks: OutboxAckEntry[]
}

/**
 * A sync notice for the UI to translate (JSON-serializable: it crosses the invoke shim). No English
 * text: `field` is the raw field key (`title`, `journal_id`, `tag_add:<id>`, ...), `reason` the raw
 * desktop refusal code (unknown codes pass through). A `refused` notice without `field` is an
 * entry the desktop could not create.
 */
export interface WebNotice {
  kind: 'replaced' | 'refused' | 'waiting_newer_desktop'
  field?: string
  title?: string
  reason?: string
}

export interface FieldNotice extends WebNotice {
  kind: 'replaced' | 'refused'
  /** Identity of the decision, so a notice is shown once per `(entry, field, change_seq)`. */
  field: string
  change_seq: number
}

export interface FieldResolution {
  resolved: boolean
  notice?: FieldNotice
}

export interface ResolveFieldParams<T> {
  fieldName: string
  change: FieldChange<T>
  syncedEntry: EntryMetadata | null
  allAcks: OutboxAcksV1[]
  /**
   * The logical path desktops key their acks on: `<webDeviceId>/outbox/<entryId>.bin` (the
   * desktop's provider listing, `outbox_import.rs` `row.path`), never `generations/g-N/…`. Only
   * decisions under this path count: `change_seq` is per web device, so another browser's intent
   * for the same entry may reuse a `(field, change_seq)` pair.
   */
  intentPath: string
  capableDesktops: string[]
  /** `<field>@<change_seq>` -> web-clock seconds of the first refusal seen. */
  firstRefusalTimes?: ReadonlyMap<string, number>
  nowSecs: number
  entryTitleOrId: string
}

/** The logical intent path desktops write into `outbox-acks.bin` (see `ResolveFieldParams`). */
export function ackIntentPath(webDeviceId: string, entryId: string): string {
  return `${webDeviceId}/outbox/${entryId}.bin`
}

/** `<field>@<change_seq>`: the key of one decision (the desktop's `decided_fields` key). */
export const decisionKey = (field: string, changeSeq: number): string => `${field}@${changeSeq}`

export const REFUSAL_BOUND_SECS = 30 * 86400

export function createEmptyOutboxFields(): OutboxFields {
  return {
    title: null,
    entry_date: null,
    emotion: null,
    is_favorite: null,
    journal_id: null,
    tags_add: {},
    tags_remove: {},
  }
}

/** Builds a notice, omitting every absent part (so it compares and serializes cleanly). */
export function formatNotice(
  kind: WebNotice['kind'],
  parts: { field?: string; title?: string; reason?: string } = {},
): WebNotice {
  const notice: WebNotice = { kind }
  if (parts.field !== undefined) notice.field = parts.field
  if (parts.title !== undefined) notice.title = parts.title
  if (parts.reason !== undefined) notice.reason = parts.reason
  return notice
}

function syncedStateReflects<T>(
  fieldName: string,
  value: T,
  syncedEntry: EntryMetadata | null,
): boolean {
  if (!syncedEntry) return false
  if (fieldName === 'title') {
    return (syncedEntry.title ?? '') === ((value as unknown as string) ?? '')
  }
  if (fieldName === 'entry_date') {
    return String(syncedEntry.entry_date) === String(value)
  }
  if (fieldName === 'emotion') {
    return (syncedEntry.emotion ?? null) === ((value as unknown as string | null) ?? null)
  }
  if (fieldName === 'is_favorite') {
    return Boolean(syncedEntry.is_favorite) === Boolean(value)
  }
  if (fieldName === 'journal_id') {
    return syncedEntry.journal_id === (value as unknown as string)
  }
  if (fieldName.startsWith('tag_add:')) {
    const tagId = fieldName.slice(8)
    return syncedEntry.tag_ids.includes(tagId)
  }
  if (fieldName.startsWith('tag_remove:')) {
    const tagId = fieldName.slice(11)
    return !syncedEntry.tag_ids.includes(tagId)
  }
  return false
}

/**
 * A conflict refusal (the entry changed since the web saw it). The desktop's `evaluate_field`
 * leaves `reason` EMPTY for it (`outbox_import.rs`); `'conflict'` is accepted too.
 */
function isConflictRefusal(decision: OutboxFieldDecision): boolean {
  return decision.reason === null || decision.reason === 'conflict'
}

/**
 * Resolves a single field change against synced state and desktop acknowledgements.
 * Follows the two-desktop ordering and conflict rules (Task 16.1):
 *  1. Synced value equals web value -> resolved silently.
 *  2. In flight: if ANY desktop reports applied/reflected, it wins over refusals until
 *     either landed or superseded by updated_at >= U.
 *  3. Deterministic refusal (any non-empty reason) -> final as soon as all capable desktops decide.
 *  4. Conflict refusal (empty reason) -> final when all capable desktops decide & synced.updated_at
 *     != base_updated_at, or after 30 days on web clock.
 */
export function resolveField<T>(params: ResolveFieldParams<T>): FieldResolution {
  const {
    fieldName,
    change,
    syncedEntry,
    allAcks,
    intentPath,
    capableDesktops,
    firstRefusalTimes,
    nowSecs,
    entryTitleOrId,
  } = params
  const notice = (kind: FieldNotice['kind'], reason?: string): FieldResolution => ({
    resolved: true,
    notice: {
      ...formatNotice(kind, { field: fieldName, title: entryTitleOrId, reason }),
      kind,
      field: fieldName,
      change_seq: change.change_seq,
    },
  })

  // 1. If synced state already reflects it, resolved silently
  if (syncedStateReflects(fieldName, change.value, syncedEntry)) {
    return { resolved: true }
  }

  // 2. Collect desktop decisions for this (field, change_seq)
  const matchingDecisions: Array<{
    desktopId: string
    decision: OutboxFieldDecision
  }> = []

  for (const ackFile of allAcks) {
    for (const ackEntry of ackFile.acks) {
      if (ackEntry.path !== intentPath) continue
      for (const dec of ackEntry.decided) {
        if (dec.field === fieldName && dec.change_seq === change.change_seq) {
          matchingDecisions.push({
            desktopId: ackFile.desktop_device_id,
            decision: dec,
          })
        }
      }
    }
  }

  const appliedDecisions = matchingDecisions.filter(
    (d) => d.decision.decision === 'applied' || d.decision.decision === 'reflected',
  )
  const refusedDecisions = matchingDecisions.filter((d) => d.decision.decision === 'refused')

  // In flight: applied wins over refused while in flight
  if (appliedDecisions.length > 0) {
    const maxU = Math.max(...appliedDecisions.map((d) => d.decision.decided_updated_at))
    if (syncedEntry !== null && syncedEntry.updated_at >= maxU) {
      // Superseded by a later desktop edit!
      return notice('replaced')
    }
    // Still in flight: do not drop, no notice
    return { resolved: false }
  }

  // No desktop reported applied: check refusals
  if (refusedDecisions.length > 0) {
    const decidingDesktops = new Set(matchingDecisions.map((d) => d.desktopId))
    const allDecided =
      capableDesktops.length > 0 && capableDesktops.every((d) => decidingDesktops.has(d))

    // Deterministic refusals: the desktop sets a reason only when applying cannot work on any
    // desktop (`journal`, `tag_not_found`, `invalid_date`, `error` or a setter's error text).
    const deterministic = refusedDecisions.find((d) => !isConflictRefusal(d.decision))
    if (deterministic && allDecided) {
      return notice('refused', deterministic.decision.reason ?? 'error')
    }

    // Conflict refusal: final if all decided and synced.updated_at != base_updated_at, OR 30 days elapsed
    const conflict = refusedDecisions.some((d) => isConflictRefusal(d.decision))
    const firstRefusal = firstRefusalTimes?.get(decisionKey(fieldName, change.change_seq))
    const thirtyDaysElapsed =
      firstRefusal !== undefined && nowSecs - firstRefusal >= REFUSAL_BOUND_SECS

    if (
      conflict &&
      ((allDecided && syncedEntry !== null && syncedEntry.updated_at !== change.base_updated_at) ||
        thirtyDaysElapsed)
    ) {
      return notice('replaced')
    }
  }

  return { resolved: false }
}

export interface ResolveFieldsParams {
  fields: OutboxFields
  syncedEntry: EntryMetadata | null
  allAcks: OutboxAcksV1[]
  intentPath: string
  capableDesktops: string[]
  firstRefusalTimes?: ReadonlyMap<string, number>
  /** `<field>@<change_seq>` keys already resolved earlier (persisted): omitted, no notice. */
  resolvedKeys?: ReadonlySet<string>
  nowSecs: number
  entryTitleOrId: string
}

/**
 * Resolves all fields in an outbox entry and returns cleaned OutboxFields (with resolved
 * fields omitted), the keys newly resolved by this call, and the notices to display.
 */
export function resolveOutboxFields(params: ResolveFieldsParams): {
  cleanedFields: OutboxFields
  notices: FieldNotice[]
  resolvedKeys: string[]
} {
  const { fields, resolvedKeys: known, ...rest } = params
  const notices: FieldNotice[] = []
  const resolvedKeys: string[] = []
  const cleaned: OutboxFields = createEmptyOutboxFields()

  const check = <T>(
    fieldName: string,
    change: FieldChange<T> | null | undefined,
  ): FieldChange<T> | null => {
    if (!change) return null
    const key = decisionKey(fieldName, change.change_seq)
    if (known?.has(key) === true) return null
    const res = resolveField({ fieldName, change, ...rest })
    if (!res.resolved) return change
    resolvedKeys.push(key)
    if (res.notice) notices.push(res.notice)
    return null
  }

  cleaned.title = check('title', fields.title)
  cleaned.entry_date = check('entry_date', fields.entry_date)
  cleaned.emotion = check('emotion', fields.emotion)
  cleaned.is_favorite = check('is_favorite', fields.is_favorite)
  cleaned.journal_id = check('journal_id', fields.journal_id)

  for (const [tagId, c] of Object.entries(fields.tags_add)) {
    const kept = check(`tag_add:${tagId}`, c)
    if (kept) cleaned.tags_add[tagId] = kept
  }

  for (const [tagId, c] of Object.entries(fields.tags_remove)) {
    const kept = check(`tag_remove:${tagId}`, c)
    if (kept) cleaned.tags_remove[tagId] = kept
  }

  return { cleanedFields: cleaned, notices, resolvedKeys }
}

/** True when no field change is left. */
export function hasNoFields(fields: OutboxFields): boolean {
  return (
    fields.title === null &&
    fields.entry_date === null &&
    fields.emotion === null &&
    fields.is_favorite === null &&
    fields.journal_id === null &&
    Object.keys(fields.tags_add).length === 0 &&
    Object.keys(fields.tags_remove).length === 0
  )
}

export interface BuildOutboxIntentParams {
  entryId: string
  webDeviceId: string
  createdOnWeb: boolean
  baseSyncedDocBytes: Uint8Array | null
  priorIntent: OutboxEntryV1 | null
  localDocBytes: Uint8Array | null
  contentText: string | null
  previewText: string | null
  newFields: Partial<{
    title: FieldChange<string> | null
    entry_date: FieldChange<string> | null
    emotion: FieldChange<string | null> | null
    is_favorite: FieldChange<boolean> | null
    journal_id: FieldChange<string> | null
    tags_add: Record<string, FieldChange<boolean>>
    tags_remove: Record<string, FieldChange<boolean>>
  }>
  mediaRefs?: OutboxMediaRef[]
  nowSecs: number
}

/**
 * Builds or rewrites an outbox intent, merging Yjs docs and accumulating fields.
 */
export function buildOutboxIntent(params: BuildOutboxIntentParams): OutboxEntryV1 {
  const {
    entryId,
    webDeviceId,
    createdOnWeb,
    baseSyncedDocBytes,
    priorIntent,
    localDocBytes,
    contentText,
    previewText,
    newFields,
    mediaRefs = [],
    nowSecs,
  } = params

  // Merge Yjs documents: base synced -> prior intent -> local edit
  const mergedDoc = new Y.Doc()
  let baseStateVector: number[] = []

  if (baseSyncedDocBytes && baseSyncedDocBytes.length > 0) {
    try {
      const baseDoc = new Y.Doc()
      Y.applyUpdate(baseDoc, baseSyncedDocBytes)
      baseStateVector = Array.from(Y.encodeStateVector(baseDoc))
      Y.applyUpdate(mergedDoc, baseSyncedDocBytes)
    } catch {
      // Corrupt base bytes: proceed with empty doc
    }
  }

  if (priorIntent && priorIntent.yjs_full_state.length > 0) {
    try {
      Y.applyUpdate(mergedDoc, new Uint8Array(priorIntent.yjs_full_state))
    } catch {
      // Corrupt prior state: proceed
    }
  }

  if (localDocBytes && localDocBytes.length > 0) {
    try {
      Y.applyUpdate(mergedDoc, localDocBytes)
    } catch {
      // Corrupt local update: proceed
    }
  }

  const yjsFullState = Array.from(Y.encodeStateAsUpdate(mergedDoc))

  // Accumulate fields from prior intent, overwriting with new fields
  const fields = priorIntent
    ? {
        ...priorIntent.fields,
        tags_add: { ...priorIntent.fields.tags_add },
        tags_remove: { ...priorIntent.fields.tags_remove },
      }
    : createEmptyOutboxFields()

  if (newFields.title !== undefined) fields.title = newFields.title
  if (newFields.entry_date !== undefined) fields.entry_date = newFields.entry_date
  if (newFields.emotion !== undefined) fields.emotion = newFields.emotion
  if (newFields.is_favorite !== undefined) fields.is_favorite = newFields.is_favorite
  if (newFields.journal_id !== undefined) fields.journal_id = newFields.journal_id

  if (newFields.tags_add) {
    Object.assign(fields.tags_add, newFields.tags_add)
  }
  if (newFields.tags_remove) {
    Object.assign(fields.tags_remove, newFields.tags_remove)
  }

  // Accumulate media refs
  const mediaMap = new Map<string, OutboxMediaRef>()
  if (priorIntent) {
    for (const m of priorIntent.media) mediaMap.set(m.media_id, m)
  }
  for (const m of mediaRefs) mediaMap.set(m.media_id, m)

  return {
    schema_version: 1,
    entry_id: entryId,
    web_device_id: webDeviceId,
    created_on_web: createdOnWeb,
    web_updated_at_secs: nowSecs,
    base_state_vector: createdOnWeb ? [] : baseStateVector,
    yjs_full_state: yjsFullState,
    content_text: contentText ?? priorIntent?.content_text ?? null,
    preview_text: previewText ?? priorIntent?.preview_text ?? null,
    fields,
    media: Array.from(mediaMap.values()),
  }
}

export interface RetainParams {
  intent: OutboxEntryV1
  /** See `ResolveFieldParams.intentPath`. */
  intentPath: string
  /**
   * SHA-256 hex of the sealed bytes on Drive (the draft's `pushedHash`, the same value the
   * desktop stores as `content_hash`), or null when this revision is not pushed.
   */
  contentHash: string | null
  /** Synced metadata, never the overlay. Null when no synced copy is known. */
  syncedEntry: EntryMetadata | null
  /** Synced Yjs full state (never the overlay), or null. */
  syncedContent: Uint8Array | null
  /** A tombstone row for the entry exists in ANY manifest. */
  tombstoned: boolean
  allAcks: OutboxAcksV1[]
  capableDesktops: string[]
  firstRefusalTimes?: ReadonlyMap<string, number>
  resolvedKeys?: ReadonlySet<string>
  nowSecs: number
}

export interface RetainResult {
  retain: boolean
  /** The create-refused notice (the intent is dropped). */
  notice?: WebNotice
  /** The intent's fields minus every resolved one: what the overlay and the next rewrite use. */
  cleanedFields: OutboxFields
  /** Fields resolved by this evaluation, `<field>@<change_seq>`. */
  resolvedKeys: string[]
  fieldNotices: FieldNotice[]
}

/**
 * Checks whether an outbox intent should be retained in IndexedDB or dropped.
 * Dropped when:
 *  - Target entry is tombstoned in any manifest, or locked or invisible in synced metadata;
 *  - Desktop refused creation for a created_on_web entry: EVERY importer-capable desktop has an
 *    ack for the CURRENT `content_hash` saying `created: false` with a `refused_reason`, and no
 *    ack of this path (any revision) says `created: true`;
 *  - All fields are resolved, the synced Yjs state already contains the intent's (no clock
 *    comparison), and every media id is in the synced metadata (`media` or `deleted_media`).
 * The caller decides whether a drop is allowed at all (never for an unpushed draft).
 */
export function shouldRetainIntent(params: RetainParams): RetainResult {
  const { intent, intentPath, contentHash, syncedEntry, syncedContent, allAcks } = params
  const { capableDesktops } = params
  const untouched = { cleanedFields: intent.fields, resolvedKeys: [], fieldNotices: [] }

  if (
    params.tombstoned ||
    (syncedEntry !== null &&
      (syncedEntry.is_deleted || syncedEntry.is_locked || syncedEntry.is_invisible))
  ) {
    return { retain: false, ...untouched }
  }

  if (intent.created_on_web && contentHash !== null) {
    const refusal = createRefusal(allAcks, intentPath, contentHash, capableDesktops)
    if (refusal !== null) {
      const notice = formatNotice('refused', {
        title: intent.fields.title?.value || undefined,
        reason: refusal,
      })
      return { retain: false, notice, ...untouched }
    }
  }

  const { cleanedFields, notices, resolvedKeys } = resolveOutboxFields({
    fields: intent.fields,
    syncedEntry,
    allAcks,
    intentPath,
    capableDesktops,
    firstRefusalTimes: params.firstRefusalTimes,
    resolvedKeys: params.resolvedKeys,
    nowSecs: params.nowSecs,
    entryTitleOrId: syncedEntry?.title || intent.fields.title?.value || intent.entry_id,
  })
  const result = { cleanedFields, resolvedKeys, fieldNotices: notices }

  const reflected =
    syncedEntry !== null &&
    hasNoFields(cleanedFields) &&
    mediaReflected(intent, syncedEntry) &&
    contentReflected(intent, syncedContent)
  return { retain: !reflected, ...result }
}

/**
 * The create-refused reason, or null. Needs an ack for the current revision from EVERY
 * importer-capable desktop (one desktop without a usable journal must not stop another from
 * creating it), all refused; any `created: true` for this path overrides.
 */
function createRefusal(
  allAcks: OutboxAcksV1[],
  intentPath: string,
  contentHash: string,
  capableDesktops: string[],
): string | null {
  let reason: string | null = null
  const decided = new Set<string>()
  for (const ackFile of allAcks) {
    for (const a of ackFile.acks) {
      if (a.path !== intentPath) continue
      if (a.created) return null
      if (a.content_hash !== contentHash) continue
      if (a.refused_reason === null) return null
      reason = a.refused_reason
      decided.add(ackFile.desktop_device_id)
    }
  }
  if (capableDesktops.length === 0 || !capableDesktops.every((d) => decided.has(d))) return null
  return reason
}

function mediaReflected(intent: OutboxEntryV1, synced: EntryMetadata): boolean {
  if (intent.media.length === 0) return true
  const ids = new Set<string>()
  for (const list of [synced.media, synced.deleted_media]) {
    if (!Array.isArray(list)) continue
    for (const m of list as unknown[]) {
      if (typeof m === 'object' && m !== null && typeof (m as { id?: unknown }).id === 'string') {
        ids.add((m as { id: string }).id)
      }
    }
  }
  return intent.media.every((m) => ids.has(m.media_id))
}

/**
 * The synced Yjs state already contains the intent's: applying the intent changes neither the
 * state vector nor the delete set. A corrupt state is "not reflected" (keep).
 */
function contentReflected(intent: OutboxEntryV1, syncedContent: Uint8Array | null): boolean {
  if (intent.yjs_full_state.length === 0) return true
  try {
    const doc = new Y.Doc({ gc: false })
    if (syncedContent !== null && syncedContent.length > 0) Y.applyUpdate(doc, syncedContent)
    const before = Y.snapshot(doc)
    Y.applyUpdate(doc, new Uint8Array(intent.yjs_full_state))
    return Y.equalSnapshots(before, Y.snapshot(doc))
  } catch {
    return false
  }
}

export function isIntentPathValid(path: string, localGen: number, ownId: string): boolean {
  return isOutboxIntentPath(path, localGen, ownId)
}

/**
 * Packages an outbox entry and all referenced media into `SafeUploadIntent[]`.
 * Enforces the strict upload ordering:
 *  1. all `outbox/m-<id>` media blobs;
 *  2. all `outbox/m-<id>.thumb` thumbnail blobs;
 *  3. `outbox/<entryId>.bin` entry intent file.
 */
export function packOutboxUploadIntents(params: {
  localGen: number
  ownDeviceId: string
  entry: OutboxEntryV1
  sealedEntryBytes: Uint8Array
  sealedMediaMap: Map<string, Uint8Array>
  plainMediaMap: Map<string, Uint8Array>
  sealedThumbMap: Map<string, Uint8Array>
  plainThumbMap: Map<string, Uint8Array>
}): SafeUploadIntent[] {
  const {
    localGen,
    ownDeviceId,
    entry,
    sealedEntryBytes,
    sealedMediaMap,
    plainMediaMap,
    sealedThumbMap,
    plainThumbMap,
  } = params

  const prefix = `generations/g-${localGen}/${ownDeviceId}/outbox`
  const intents: SafeUploadIntent[] = []

  // 1. Media blobs
  for (const m of entry.media) {
    const sealed = sealedMediaMap.get(m.media_id)
    const plain = plainMediaMap.get(m.media_id)
    if (sealed && plain) {
      intents.push({
        path: `${prefix}/m-${m.media_id}`,
        bytes: sealed,
        intended: { kind: 'media', plaintext: plain },
      })
    }
  }

  // 2. Thumbnails
  for (const m of entry.media) {
    if (m.has_thumb) {
      const sealed = sealedThumbMap.get(m.media_id)
      const plain = plainThumbMap.get(m.media_id)
      if (sealed && plain) {
        intents.push({
          path: `${prefix}/m-${m.media_id}.thumb`,
          bytes: sealed,
          intended: { kind: 'thumb', plaintext: plain },
        })
      }
    }
  }

  // 3. Entry intent
  intents.push({
    path: `${prefix}/${entry.entry_id}.bin`,
    bytes: sealedEntryBytes,
    intended: { kind: 'entry', entry },
  })

  return intents
}
