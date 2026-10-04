import { describe, expect, it } from 'vitest'
import type { Entry } from '../../src/types/entry'
import {
  entriesById,
  ENTRY_1_ID,
  ENTRY_4_ID,
  ENTRY_12_ID,
  journalsById,
  tagsForEntry,
} from '../fixtures'
import { scenarios } from './index'

describe('logged-in tag handlers', () => {
  it('returns batched tags for known entry ids and omits unknown ids', () => {
    const loggedIn = scenarios.find((scenario) => scenario.id === 'logged-in')
    const handler = loggedIn?.invoke?.get_tags_for_entries
    const richEntry = Array.from(tagsForEntry).find(([, entryTags]) => entryTags.length >= 6)
    const knownEntryId = richEntry?.[0]

    expect(knownEntryId).toBeDefined()
    expect(richEntry?.[1].length).toBeGreaterThanOrEqual(6)
    expect(typeof handler).toBe('function')
    if (knownEntryId === undefined || typeof handler !== 'function') return

    expect(handler({ entryIds: [knownEntryId, 'unknown-entry'], activeVaultId: null })).toEqual({
      [knownEntryId]: tagsForEntry.get(knownEntryId),
    })
  })

  it('filters effectively invisible entry tags unless the session reveals them', () => {
    const loggedIn = scenarios.find((scenario) => scenario.id === 'logged-in')
    const handler = loggedIn?.invoke?.get_tags_for_entries
    const entryInvisible = entriesById.get(ENTRY_1_ID)
    const journalInvisibleEntry = entriesById.get(ENTRY_4_ID)
    const invisibleJournal = journalInvisibleEntry
      ? journalsById.get(journalInvisibleEntry.journal_id)
      : undefined
    const entryInvisibleTags = tagsForEntry.get(ENTRY_1_ID)
    const journalInvisibleTags = tagsForEntry.get(ENTRY_4_ID)

    expect(typeof handler).toBe('function')
    expect(entryInvisible).toBeDefined()
    expect(invisibleJournal).toBeDefined()
    expect(entryInvisibleTags?.length).toBeGreaterThan(0)
    expect(journalInvisibleTags?.length).toBeGreaterThan(0)
    if (
      typeof handler !== 'function' ||
      entryInvisible === undefined ||
      invisibleJournal === undefined ||
      entryInvisibleTags === undefined ||
      journalInvisibleTags === undefined
    ) {
      return
    }

    const originalEntryInvisible = entryInvisible.is_invisible
    const originalJournalInvisible = invisibleJournal.is_invisible
    const originalEntryVault = entryInvisible.vault_id
    const originalJournalVault = invisibleJournal.vault_id
    entryInvisible.is_invisible = true
    entryInvisible.vault_id = 'vault-a'
    invisibleJournal.is_invisible = true
    invisibleJournal.vault_id = 'vault-a'

    try {
      expect(
        handler({
          entryIds: [ENTRY_1_ID, ENTRY_4_ID],
          activeVaultId: null,
        }),
      ).toEqual({})
      expect(
        handler({
          entryIds: [ENTRY_1_ID, ENTRY_4_ID],
          activeVaultId: 'vault-a',
        }),
      ).toEqual({
        [ENTRY_1_ID]: entryInvisibleTags,
        [ENTRY_4_ID]: journalInvisibleTags,
      })
    } finally {
      entryInvisible.is_invisible = originalEntryInvisible
      entryInvisible.vault_id = originalEntryVault
      invisibleJournal.is_invisible = originalJournalInvisible
      invisibleJournal.vault_id = originalJournalVault
    }
  })

  it('redacts covered second-locked entries like the backend', () => {
    const loggedIn = scenarios.find((scenario) => scenario.id === 'logged-in')
    const handler = loggedIn?.invoke?.list_all_entries_paged

    expect(typeof handler).toBe('function')
    if (typeof handler !== 'function') return

    const result = handler({ lockedView: 'covered', activeVaultId: null })
    const covered = result.items.find((entry: Entry) => entry.id === ENTRY_12_ID)

    expect(covered).toMatchObject({
      is_locked: true,
      title: null,
      preview_text: null,
      content_text: null,
      location_label: null,
      weather_summary: null,
      weather_icon: null,
      cover_media_id: null,
    })
  })
})
