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

export interface FieldResolution {
  resolved: boolean
  notice?: {
    text: string
    kind: 'replaced' | 'refused'
  }
}

export interface ResolveFieldParams<T> {
  fieldName: string
  change: FieldChange<T>
  syncedEntry: EntryMetadata | null
  allAcks: OutboxAcksV1[]
  capableDesktops: string[]
  firstRefusalTimes?: Map<string, number>
  nowSecs: number
  entryTitleOrId: string
}

const FIELD_LABELS: Record<string, string> = {
  title: 'title',
  entry_date: 'entry date',
  emotion: 'emotion',
  is_favorite: 'favorite',
  journal_id: 'journal',
}

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

export function formatNotice(
  kind: 'replaced' | 'refused' | 'create_refused',
  detail: string,
  entryTitleOrId?: string,
): string {
  if (kind === 'replaced') {
    return `This edit was replaced by a change from your desktop: ${detail} of ${entryTitleOrId ?? ''}`
  }
  if (kind === 'refused') {
    return `Your desktop could not apply: ${detail}`
  }
  return `This entry could not be added on your desktop: ${detail}`
}

function syncedStateReflects<T>(
  fieldName: string,
  value: T,
  syncedEntry: EntryMetadata | null,
): boolean {
  if (!syncedEntry) return false
  if (fieldName === 'title') {
    return (syncedEntry.title ?? '') === (value as unknown as string ?? '')
  }
  if (fieldName === 'entry_date') {
    return String(syncedEntry.entry_date) === String(value)
  }
  if (fieldName === 'emotion') {
    return (syncedEntry.emotion ?? null) === (value as unknown as string | null ?? null)
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
 * Resolves a single field change against synced state and desktop acknowledgements.
 * Follows the two-desktop ordering and conflict rules (Task 16.1):
 *  1. Synced value equals web value -> resolved silently.
 *  2. In flight: if ANY desktop reports applied/reflected, it wins over refusals until
 *     either landed or superseded by updated_at >= U.
 *  3. Deterministic refusal (journal, error, empty_base) -> final as soon as all capable desktops decide.
 *  4. Conflict refusal -> final when all capable desktops decide & synced.updated_at != base_updated_at,
 *     or after 30 days on web clock.
 */
export function resolveField<T>(params: ResolveFieldParams<T>): FieldResolution {
  const {
    fieldName,
    change,
    syncedEntry,
    allAcks,
    capableDesktops,
    firstRefusalTimes,
    nowSecs,
    entryTitleOrId,
  } = params

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
  const refusedDecisions = matchingDecisions.filter(
    (d) => d.decision.decision === 'refused',
  )

  // In flight: applied wins over refused while in flight
  if (appliedDecisions.length > 0) {
    const maxU = Math.max(...appliedDecisions.map((d) => d.decision.decided_updated_at))
    if (syncedEntry !== null && syncedEntry.updated_at >= maxU) {
      // Superseded by a later desktop edit!
      const label = FIELD_LABELS[fieldName] ?? fieldName
      return {
        resolved: true,
        notice: {
          kind: 'replaced',
          text: formatNotice('replaced', label, entryTitleOrId),
        },
      }
    }
    // Still in flight: do not drop, no notice
    return { resolved: false }
  }

  // No desktop reported applied: check refusals
  if (refusedDecisions.length > 0) {
    const decidingDesktops = new Set(matchingDecisions.map((d) => d.desktopId))
    const allDecided =
      capableDesktops.length > 0 &&
      capableDesktops.every((d) => decidingDesktops.has(d))

    // Deterministic refusals (journal, error, empty_base)
    const deterministic = refusedDecisions.find(
      (d) =>
        d.decision.reason === 'journal' ||
        d.decision.reason === 'error' ||
        d.decision.reason === 'empty_base',
    )
    if (deterministic && allDecided) {
      return {
        resolved: true,
        notice: {
          kind: 'refused',
          text: formatNotice('refused', deterministic.decision.reason ?? 'error'),
        },
      }
    }

    // Conflict refusal: final if all decided and synced.updated_at != base_updated_at, OR 30 days elapsed
    const conflict = refusedDecisions.some((d) => d.decision.reason === 'conflict')
    const refusalKey = `${fieldName}@${change.change_seq}`
    const firstRefusal = firstRefusalTimes?.get(refusalKey)
    const thirtyDaysElapsed =
      firstRefusal !== undefined && nowSecs - firstRefusal >= 30 * 86400

    if (
      conflict &&
      ((allDecided && syncedEntry !== null && syncedEntry.updated_at !== change.base_updated_at) ||
        thirtyDaysElapsed)
    ) {
      const label = FIELD_LABELS[fieldName] ?? fieldName
      return {
        resolved: true,
        notice: {
          kind: 'replaced',
          text: formatNotice('replaced', label, entryTitleOrId),
        },
      }
    }
  }

  return { resolved: false }
}

/**
 * Resolves all fields in an outbox entry and returns cleaned OutboxFields (with resolved
 * fields omitted) along with any notices that should be displayed to the user.
 */
export function resolveOutboxFields(params: {
  fields: OutboxFields
  syncedEntry: EntryMetadata | null
  allAcks: OutboxAcksV1[]
  capableDesktops: string[]
  firstRefusalTimes?: Map<string, number>
  nowSecs: number
  entryTitleOrId: string
}): {
  cleanedFields: OutboxFields
  notices: Array<{ text: string; kind: 'replaced' | 'refused' }>
} {
  const { fields, ...rest } = params
  const notices: Array<{ text: string; kind: 'replaced' | 'refused' }> = []
  const cleaned: OutboxFields = createEmptyOutboxFields()

  const check = <T>(
    fieldName: string,
    change: FieldChange<T> | null | undefined,
  ): FieldChange<T> | null => {
    if (!change) return null
    const res = resolveField({ fieldName, change, ...rest })
    if (res.notice) notices.push(res.notice)
    return res.resolved ? null : change
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

  return { cleanedFields: cleaned, notices }
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

/**
 * Checks whether an outbox intent should be retained in IndexedDB or dropped.
 * Dropped when:
 *  - Target entry is tombstoned in any manifest (is_deleted: true);
 *  - Target entry is locked or invisible;
 *  - All fields are resolved, content text matches synced, and all media_ids exist in metadata;
 *  - Or desktop refused creation for created_on_web entry.
 */
export function shouldRetainIntent(params: {
  intent: OutboxEntryV1
  syncedEntry: EntryMetadata | null
  allAcks: OutboxAcksV1[]
  capableDesktops: string[]
  nowSecs: number
}): { retain: boolean; notice?: string } {
  const { intent, syncedEntry, allAcks, capableDesktops, nowSecs } = params

  if (syncedEntry) {
    if (syncedEntry.is_deleted || syncedEntry.is_locked || syncedEntry.is_invisible) {
      return { retain: false }
    }
  }

  // Check if every desktop ack matching this content_hash says created: false with refused_reason
  if (intent.created_on_web && allAcks.length > 0) {
    let allRefused = true
    let refusedReason: string | null = null
    let anyCreated = false

    for (const ackFile of allAcks) {
      for (const a of ackFile.acks) {
        if (a.path.endsWith(`${intent.entry_id}.bin`)) {
          if (a.created) {
            anyCreated = true
          } else if (a.refused_reason) {
            refusedReason = a.refused_reason
          } else {
            allRefused = false
          }
        }
      }
    }

    if (!anyCreated && allRefused && refusedReason) {
      return {
        retain: false,
        notice: formatNotice('create_refused', refusedReason),
      }
    }
  }

  // Check field resolutions
  const { cleanedFields } = resolveOutboxFields({
    fields: intent.fields,
    syncedEntry,
    allAcks,
    capableDesktops,
    nowSecs,
    entryTitleOrId: syncedEntry?.title ?? intent.entry_id,
  })

  const hasRemainingFields =
    cleanedFields.title !== null ||
    cleanedFields.entry_date !== null ||
    cleanedFields.emotion !== null ||
    cleanedFields.is_favorite !== null ||
    cleanedFields.journal_id !== null ||
    Object.keys(cleanedFields.tags_add).length > 0 ||
    Object.keys(cleanedFields.tags_remove).length > 0

  if (hasRemainingFields) return { retain: true }

  // If entry exists in synced files, verify content and media refs
  if (syncedEntry) {
    // Check media
    if (intent.media.length > 0) {
      const syncedMediaList = Array.isArray(syncedEntry.media)
        ? (syncedEntry.media as Array<{ id?: string; media_id?: string }>)
        : []
      const syncedMediaIds = new Set(
        syncedMediaList.map((m) => m.id ?? m.media_id).filter(Boolean),
      )
      const allMediaPresent = intent.media.every((m) => syncedMediaIds.has(m.media_id))
      if (!allMediaPresent) return { retain: true }
    }

    // Check content text
    if (intent.content_text !== null && intent.content_text !== '') {
      if (syncedEntry.content_text !== intent.content_text) {
        // Content might have merged or changed; if synced updated_at > web_updated_at_secs, consider reflected
        if (syncedEntry.updated_at < intent.web_updated_at_secs) {
          return { retain: true }
        }
      }
    }

    // All fields resolved, media present, content reflected
    return { retain: false }
  }

  return { retain: true }
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
