/**
 * Journals, tags and templates, read-only (Phase 10.3). The data comes from the device-root
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
 */

import type { Tag } from '../../../../src/types/journal'
import type { Handler } from '../router'
import { EntryNotAvailableError, loadVisible } from './entries'
import { openForRead, type Taxonomy } from './readSession'

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
}
