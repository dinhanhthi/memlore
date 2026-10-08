/**
 * The pending outbox v2 overlay (Phase 22): what this browser created, edited or deleted that no
 * synced file shows yet.
 *
 * - Journal / tag creates and template upserts / deletes come from the stored `j-` / `t-` / `p-`
 *   drafts (pushed or not), opened with the current ring. A draft that does not open, or whose body
 *   does not match its key, is skipped (logged by error name) and kept, as push and retention do.
 * - Trashed entries come from the `d-<entryId>` draft KEYS: nothing to decrypt.
 *
 * `overlayTaxonomy` is applied by `openForRead` / `openForWrite` only. The session's own taxonomy
 * (`ready()`, read by push hold-back and by retention) stays the SYNCED one: a pending create seen
 * there would lift the push hold-back of the entries naming it, and a pending template upsert would
 * look reflected and be dropped. A pending create already present in the synced files (any state)
 * is not overlaid: the synced record wins.
 *
 * The overlay disappears with its draft: retention drops a draft once it is reflected, acked or
 * finally refused (Phase 21), and the session re-reads this overlay after every retention pass.
 */

import type { Core, OutboxIntentV2 } from '../../core/core'
import type { Journal, Tag } from '../../../../src/types/journal'
import type { Template } from '../../../../src/types/template'
import type { KeyRing } from '../keys'
import { draftKind, draftTargetId, type DraftRecord } from '../storage/idb'
import { openV2Intent, v2IntentTarget } from '../sync/safeUpload'
import type { Taxonomy } from './readSession'

export interface PendingV2 {
  /** Journal, tag and template intents of this browser's stored drafts. */
  intents: readonly OutboxIntentV2[]
  /** Entry ids with a stored trash draft. */
  trashedEntryIds: readonly string[]
}

export const NO_PENDING: PendingV2 = { intents: [], trashedEntryIds: [] }

/** The pending overlay of these stored drafts (see the header). Never throws for one bad draft. */
export function pendingFromDrafts(
  drafts: readonly DraftRecord[],
  core: Pick<Core, 'openOutboxIntent'>,
  ring: KeyRing,
): PendingV2 {
  const intents: OutboxIntentV2[] = []
  const trashedEntryIds: string[] = []
  for (const draft of drafts) {
    const kind = draftKind(draft)
    if (kind === 'entry') continue
    if (kind === 'trash') {
      trashedEntryIds.push(draftTargetId(draft))
      continue
    }
    try {
      const intent = openV2Intent(core, ring, draft.sealed)
      const { prefix, id } = v2IntentTarget(intent)
      if (draft.entryId !== `${prefix}-${id}`) throw new Error('not a v2 intent for this draft')
      intents.push(intent)
    } catch (error) {
      // Log the error name only: a JSON.parse message can quote decrypted text.
      const reason = error instanceof Error ? error.name : typeof error
      console.warn(`Skipping draft ${draft.entryId}: it could not be opened (${reason})`)
    }
  }
  return { intents, trashedEntryIds }
}

/** Journal ids this browser created that the synced files do not show yet. */
export function pendingJournalIds(synced: Taxonomy, pending: PendingV2): string[] {
  const known = new Set(synced.knownJournalIds)
  return pending.intents.flatMap((i) =>
    i.kind === 'create_journal' && !known.has(i.journal_id) ? [i.journal_id] : [],
  )
}

function decodeBase64(b64: string | null): number[] | null {
  if (b64 === null) return null
  try {
    return Array.from(atob(b64), (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

const byJournalOrder = (a: Journal, b: Journal): number =>
  a.sort_order - b.sort_order || a.created_at - b.created_at
const byName = (a: Tag, b: Tag): number => a.name.localeCompare(b.name)
const byTemplateOrder = (a: Template, b: Template): number =>
  a.sort_order - b.sort_order || a.name.localeCompare(b.name)

/** The synced taxonomy with this browser's pending creates, template edits and deletes applied. */
export function overlayTaxonomy(synced: Taxonomy, pending: PendingV2): Taxonomy {
  if (pending.intents.length === 0) return synced
  const knownJournals = new Set(synced.knownJournalIds)
  const knownTags = new Set(synced.knownTagIds)
  const journals = [...synced.journals]
  const knownJournalIds = [...synced.knownJournalIds]
  // No prototype: a journal id such as `__proto__` is an ordinary key.
  const autoTagIds = Object.assign(
    Object.create(null) as Record<string, string[]>,
    synced.autoTagIds,
  )
  const tags = [...synced.tags]
  let templates = [...synced.templates]
  for (const intent of pending.intents) {
    switch (intent.kind) {
      case 'create_journal':
        if (knownJournals.has(intent.journal_id)) break
        journals.push({
          id: intent.journal_id,
          name: intent.name,
          color: intent.color,
          created_at: intent.web_updated_at_secs,
          updated_at: intent.web_updated_at_secs,
          sort_order: 0,
          is_deleted: false,
          is_locked: false,
          is_invisible: false,
          vault_id: null,
          is_initial_placeholder: false,
        })
        knownJournalIds.push(intent.journal_id)
        autoTagIds[intent.journal_id] = [...intent.auto_tag_ids]
        break
      case 'create_tag':
        if (knownTags.has(intent.tag_id)) break
        tags.push({ id: intent.tag_id, name: intent.name, color: intent.color })
        break
      case 'upsert_template': {
        const current = templates.find((t) => t.id === intent.template_id)
        const next: Template = {
          id: intent.template_id,
          name: intent.name,
          description: intent.description,
          content: decodeBase64(intent.content_b64),
          is_predefined: false,
          sort_order: intent.sort_order,
          created_at: current?.created_at ?? intent.web_updated_at_secs,
        }
        templates = [...templates.filter((t) => t.id !== intent.template_id), next]
        break
      }
      case 'delete_template':
        templates = templates.filter((t) => t.id !== intent.template_id)
        break
      case 'trash_entry':
        break // carried by the draft key (`trashedEntryIds`)
    }
  }
  return {
    ...synced,
    journals: journals.sort(byJournalOrder),
    autoTagIds,
    knownJournalIds,
    tags: tags.sort(byName),
    templates: templates.sort(byTemplateOrder),
  }
}
