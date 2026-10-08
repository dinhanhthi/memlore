/**
 * Journals, tags and templates (reads Phase 10.3, writes Phase 22.1). The data comes from the device-root
 * `journals/*.bin`, `tags.bin` and `templates.bin` files cached by the puller, merged across
 * devices by last-write-wins per id (see readSession.ts `readTaxonomy`).
 *
 * - Journals: deleted, locked and invisible journals are not listed and `get_journal` answers null
 *   for them. Their ids feed `vault.setExcludedJournalIds` (readSession.ts).
 * - Tags: every live tag is listed (a tag only used by hidden entries cannot be told apart without
 *   loading them). `get_tags_with_counts` counts the LOADED visible entries only, so the numbers
 *   are lower bounds until more entries are loaded; the order is count desc, name asc as on desktop.
 * - Templates: user templates only. Desktop seeds its predefined templates per device and never
 *   syncs them, so the web has none.
 * - `get_tags_for_entry` loads that one entry when needed; `get_tags_for_entries` answers only for
 *   entries already loaded (it never fans out downloads).
 *
 * Writes (Phase 22.1, outbox v2): `create_journal`, `create_tag`, `create_template`,
 * `update_template` and `delete_template` each store ONE v2 draft (`j-` / `t-` / `p-<id>`, new
 * lowercase UUIDs for creates); push uploads it once a desktop advertises `outbox_versions ∋ 2`.
 * Every list here shows the pending overlay at once (`pendingTaxonomy.ts`), so entries can be moved
 * into a pending journal or tagged with a pending tag (push holds those entry drafts back until the
 * create is reflected). Gates, in order: locked (`VaultLockedError`), writes off (`read_only`, as the
 * entry writes), no v2-capable desktop (`WebUnsupportedError`, as the stubs these replace).
 * Validation mirrors the desktop and memlore-core `OutboxIntentV2::validate`: names trimmed (journal,
 * tag), non-empty, at most 200 characters; colors `#RRGGBB`; template description / content caps.
 * A journal name taken by a visible or locked synced journal or a pending one, or a tag name of a
 * deleted tag, is refused with `name_taken` (the desktop importer would refuse it for good); a live
 * tag name answers that tag, as desktop `create_tag` (get-or-create) does. The three creates run
 * under the outbox lock and re-read the pending overlay there, so two concurrent creates of one
 * name in a tab cannot both store a draft.
 * Template bases (`base_updated_at`, desktop-wins on the desktop): a template only this browser
 * created stays a create (upsert `null`, delete `0`: the desktop chains both on its own create);
 * a pending edit keeps its base; otherwise the synced template's `updated_at`.
 * Journal and tag rename / recolor / delete stay unsupported on the web (`unsupported.ts`).
 */

import type { Journal, Tag } from '../../../../src/types/journal'
import type { Template } from '../../../../src/types/template'
import { sealOutboxIntentV2, type OutboxIntentV2 } from '../../core/core'
import { nowSecs } from '../clock'
import { createDraftManager } from '../drafts'
import { isUuid } from '../drive/paths'
import { getKeyRing } from '../keys'
import type { Handler } from '../router'
import { openV2Intent, v2IntentTarget } from '../sync/safeUpload'
import { WebUnsupportedError } from '../unsupported'
import { EntryNotAvailableError, assertWritesEnabled, loadVisible, outboxWrite } from './entries'
import { overlayTaxonomy } from './pendingTaxonomy'
import { openForRead, openForWrite, type Taxonomy } from './readSession'

const byName = (a: Tag, b: Tag): number => a.name.localeCompare(b.name)

function tagsOf(ids: readonly string[], taxonomy: Taxonomy): Tag[] {
  const wanted = new Set(ids)
  return taxonomy.tags.filter((t) => wanted.has(t.id)).sort(byName)
}

const listJournals: Handler = async () => (await openForRead()).taxonomy.journals

const getJournal: Handler = async ({ id }) =>
  (await openForRead()).taxonomy.journals.find((j) => j.id === id) ?? null

const listJournalAutoTags: Handler = async ({ journalId }) => {
  const { taxonomy } = await openForRead()
  const key = String(journalId)
  return tagsOf(Object.hasOwn(taxonomy.autoTagIds, key) ? taxonomy.autoTagIds[key] : [], taxonomy)
}

const listTags: Handler = async () => (await openForRead()).taxonomy.tags

const getTagsWithCounts: Handler = async () => {
  const { vault, taxonomy } = await openForRead()
  const counts = vault.tagCounts()
  return taxonomy.tags
    .map((tag): [Tag, number] => [tag, counts.get(tag.id) ?? 0])
    .sort((a, b) => b[1] - a[1] || byName(a[0], b[0]))
}

const getTagsForEntry: Handler = async ({ entryId }) => {
  const { vault, taxonomy } = await openForRead()
  try {
    const entry = await loadVisible(vault, String(entryId))
    return entry === null ? [] : tagsOf(entry.metadata.tag_ids, taxonomy)
  } catch (error) {
    // Desktop answers an empty list for an entry the caller may not see.
    if (error instanceof EntryNotAvailableError) return []
    throw error
  }
}

const getTagsForEntries: Handler = async ({ entryIds }) => {
  const { vault, taxonomy } = await openForRead()
  const loaded = new Map(vault.listLoaded().map((e) => [e.metadata.entry_id, e]))
  // No prototype: an entry id such as `__proto__` is an ordinary key.
  const out: Record<string, Tag[]> = Object.create(null) as Record<string, Tag[]>
  for (const id of Array.isArray(entryIds) ? entryIds : []) {
    const entry = typeof id === 'string' ? loaded.get(id) : undefined
    if (entry === undefined) continue
    const tags = tagsOf(entry.metadata.tag_ids, taxonomy)
    if (tags.length > 0) out[entry.metadata.entry_id] = tags
  }
  return out
}

const listTemplates: Handler = async () => (await openForRead()).taxonomy.templates

const getTemplate: Handler = async ({ id }) =>
  (await openForRead()).taxonomy.templates.find((t) => t.id === id) ?? null

// ---------------------------------------------------------------------------------------------
// Writes (outbox v2, Phase 22.1)
// ---------------------------------------------------------------------------------------------

/** memlore-core `outbox.rs` caps (`MAX_INTENT_NAME_CHARS`, `MAX_AUTO_TAG_IDS`, template caps). */
const MAX_NAME_CHARS = 200
const MAX_AUTO_TAG_IDS = 100
const MAX_TEMPLATE_DESCRIPTION_BYTES = 4 * 1024
const MAX_TEMPLATE_CONTENT_BYTES = 8 * 1024 * 1024
const COLOR = /^#[0-9a-fA-F]{6}$/

type WriteSession = Awaited<ReturnType<typeof openForWrite>>
type Kind = 'journal' | 'tag' | 'template'

/** Opens the write session behind the three gates of the header. */
async function openV2Write(command: string): Promise<WriteSession> {
  const w = await openForWrite()
  assertWritesEnabled()
  if (!w.outboxV2Capable) throw new WebUnsupportedError(command)
  return w
}

function checkName(raw: unknown, trim: boolean): string {
  if (typeof raw !== 'string') throw new Error('name is required')
  const name = trim ? raw.trim() : raw
  if (name.trim() === '') throw new Error('name must not be empty')
  if ([...name].length > MAX_NAME_CHARS) {
    throw new Error(`name is longer than ${MAX_NAME_CHARS} characters`)
  }
  return name
}

function checkColor(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string' || !COLOR.test(raw)) {
    throw new Error(`invalid color ${String(raw)}: expected #RRGGBB`)
  }
  return raw
}

function checkAutoTags(raw: unknown, taxonomy: Taxonomy): string[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new Error('autoTagIds must be a list')
  const ids = [...new Set(raw as unknown[])]
  if (ids.length > MAX_AUTO_TAG_IDS) throw new Error(`more than ${MAX_AUTO_TAG_IDS} auto tags`)
  const live = new Set(taxonomy.tags.map((t) => t.id))
  for (const id of ids) {
    if (typeof id !== 'string' || !live.has(id)) throw new Error(`Tag not found: ${String(id)}`)
  }
  return ids as string[]
}

function checkDescription(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') throw new Error('description must be text')
  if (new TextEncoder().encode(raw).length > MAX_TEMPLATE_DESCRIPTION_BYTES) {
    throw new Error(`template description exceeds ${MAX_TEMPLATE_DESCRIPTION_BYTES} bytes`)
  }
  return raw
}

const isByte = (b: unknown): boolean =>
  Number.isInteger(b) && (b as number) >= 0 && (b as number) <= 255

/** The template body (`Vec<u8>` on desktop) as standard base64, or null. */
function contentB64(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  const bytes =
    raw instanceof Uint8Array
      ? raw
      : Array.isArray(raw) && raw.every(isByte)
        ? Uint8Array.from(raw as number[])
        : null
  if (bytes === null) throw new Error('template content must be bytes')
  if (bytes.length > MAX_TEMPLATE_CONTENT_BYTES) {
    throw new Error(`template content exceeds ${MAX_TEMPLATE_CONTENT_BYTES} bytes`)
  }
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/** `web_device_id` and `web_updated_at_secs` (Drive-corrected clock) of a new intent. */
async function intentStamp(
  w: WriteSession,
): Promise<{ web_device_id: string; web_updated_at_secs: number }> {
  const device = await w.db.device.get()
  if (!device) throw new Error('Device record missing')
  return { web_device_id: device.deviceId, web_updated_at_secs: nowSecs() }
}

/** Seals and stores the draft, then re-reads the pending overlay so every view shows it. */
async function saveIntent(w: WriteSession, kind: Kind, intent: OutboxIntentV2): Promise<void> {
  const sealed = sealOutboxIntentV2(w.core, getKeyRing(), intent)
  const { prefix, id } = v2IntentTarget(intent)
  await createDraftManager({ db: w.db }).saveDraft(`${prefix}-${id}`, sealed, kind)
  await w.refreshPendingV2()
}

/** The synced taxonomy with just this intent applied (the record a create / edit returns). */
const withIntent = (w: WriteSession, intent: OutboxIntentV2): Taxonomy =>
  overlayTaxonomy(w.synced, { intents: [intent], trashedEntryIds: [] })

const createJournal = outboxWrite(async ({ payload }, lock) => {
  const w = await openV2Write('create_journal')
  const p: Record<string, unknown> =
    typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
  const name = checkName(p.name, true)
  const color = checkColor(p.color)
  // Under the lock, the name check and the draft save are atomic within this tab.
  await lock()
  const taxonomy = w.currentTaxonomy()
  const autoTagIds = checkAutoTags(p.autoTagIds, taxonomy)
  // The desktop importer refuses a name a live visible OR locked journal already has (`name_taken`).
  if (
    taxonomy.journals.some((j) => j.name.trim() === name) ||
    taxonomy.lockedJournalNames.some((n) => n.trim() === name)
  ) {
    throw new Error('name_taken')
  }
  const intent: OutboxIntentV2 = {
    ...(await intentStamp(w)),
    kind: 'create_journal',
    journal_id: crypto.randomUUID(),
    name,
    color,
    auto_tag_ids: autoTagIds,
  }
  await saveIntent(w, 'journal', intent)
  return withIntent(w, intent).journals.find((j) => j.id === intent.journal_id) as Journal
})

const createTag = outboxWrite(async ({ name: rawName, color: rawColor }, lock) => {
  const w = await openV2Write('create_tag')
  const name = checkName(rawName, true)
  const color = checkColor(rawColor)
  // Under the lock, the name check and the draft save are atomic within this tab.
  await lock()
  const taxonomy = w.currentTaxonomy()
  const existing = taxonomy.tags.find((t) => t.name === name)
  if (existing !== undefined) return existing
  // `tags.name` is unique over live AND deleted rows on desktop; the web cannot resurrect one.
  if (taxonomy.deletedTagNames.includes(name)) throw new Error('name_taken')
  const intent: OutboxIntentV2 = {
    ...(await intentStamp(w)),
    kind: 'create_tag',
    tag_id: crypto.randomUUID(),
    name,
    color,
  }
  await saveIntent(w, 'tag', intent)
  const tag: Tag = { id: intent.tag_id, name, color }
  return tag
})

const createTemplate = outboxWrite(async (args, lock) => {
  const w = await openV2Write('create_template')
  const name = checkName(args.name, false)
  const description = checkDescription(args.description)
  const content = contentB64(args.content)
  await lock()
  const intent: OutboxIntentV2 = {
    ...(await intentStamp(w)),
    kind: 'upsert_template',
    template_id: crypto.randomUUID(),
    name,
    description,
    content_b64: content,
    sort_order: 0, // desktop `create_template`
    base_updated_at: null,
  }
  await saveIntent(w, 'template', intent)
  return withIntent(w, intent).templates.find((t) => t.id === intent.template_id) as Template
})

/**
 * The template an edit or delete acts on and its desktop base (see the header). Reads the stored
 * `p-<id>` draft: call it under the outbox lock. Throws when the template is not visible here.
 */
async function templateTarget(
  w: WriteSession,
  id: string,
): Promise<{ sortOrder: number; upsertBase: number | null; deleteBase: number }> {
  const notFound = new Error(`Template not found: ${id}`)
  if (!isUuid(id)) throw notFound
  const stored = await w.db.drafts.get(`p-${id}`)
  if (stored !== undefined) {
    const prior = openV2Intent(w.core, getKeyRing(), stored.sealed)
    if (prior.kind !== 'upsert_template' || prior.template_id !== id) throw notFound
    return {
      sortOrder: prior.sort_order,
      upsertBase: prior.base_updated_at,
      deleteBase: prior.base_updated_at ?? 0,
    }
  }
  const synced = w.synced.templates.find((t) => t.id === id)
  const base = Object.hasOwn(w.synced.templateUpdatedAt, id) ? w.synced.templateUpdatedAt[id] : null
  if (synced === undefined || base === null) throw notFound
  return { sortOrder: synced.sort_order, upsertBase: base, deleteBase: base }
}

const updateTemplate = outboxWrite(async (args, lock) => {
  const w = await openV2Write('update_template')
  const id = String(args.id ?? '')
  const name = checkName(args.name, false)
  const description = checkDescription(args.description)
  const content = contentB64(args.content)
  await lock()
  const target = await templateTarget(w, id)
  const intent: OutboxIntentV2 = {
    ...(await intentStamp(w)),
    kind: 'upsert_template',
    template_id: id,
    name,
    description,
    content_b64: content,
    sort_order: target.sortOrder,
    base_updated_at: target.upsertBase,
  }
  await saveIntent(w, 'template', intent)
  return withIntent(w, intent).templates.find((t) => t.id === id) as Template
})

const deleteTemplate = outboxWrite(async (args, lock) => {
  const w = await openV2Write('delete_template')
  const id = String(args.id ?? '')
  await lock()
  const target = await templateTarget(w, id)
  await saveIntent(w, 'template', {
    ...(await intentStamp(w)),
    kind: 'delete_template',
    template_id: id,
    base_updated_at: target.deleteBase,
  })
})

export const taxonomyHandlers: Record<string, Handler> = {
  list_journals: listJournals,
  get_journal: getJournal,
  list_journal_auto_tags: listJournalAutoTags,
  list_tags: listTags,
  get_tags_with_counts: getTagsWithCounts,
  get_tags_for_entry: getTagsForEntry,
  get_tags_for_entries: getTagsForEntries,
  list_templates: listTemplates,
  get_template: getTemplate,
  create_journal: createJournal,
  create_tag: createTag,
  create_template: createTemplate,
  update_template: updateTemplate,
  delete_template: deleteTemplate,
}
