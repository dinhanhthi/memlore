import { describe, it, expect, beforeEach } from 'vitest'
import { useEntryStore } from './entryStore'
import type { Entry } from '../types/entry'

const makeEntry = (overrides: Partial<Entry> = {}): Entry => ({
  id: 'entry-1',
  journal_id: 'journal-1',
  title: 'Test Entry',
  preview_text: 'Preview',
  content_text: 'Full content',
  entry_date: 1744640400,
  created_at: 1744640400,
  updated_at: 1744640400,
  latitude: null,
  longitude: null,
  location_label: null,
  location_address: null,
  weather_summary: null,
  weather_icon: null,
  emotion: null,
  is_favorite: false,
  is_deleted: false,
  is_locked: false,
  is_invisible: false,
  vault_id: null,
  cover_media_id: null,
  media_count: 0,
  from_chat: false,
  content_language: null,
  entry_date_user_edited: false,
  ...overrides,
})

beforeEach(() => {
  useEntryStore.setState({
    entries: [],
    entriesById: {},
    isLoading: false,
    error: null,
  })
})

describe('entryStore — initial state', () => {
  it('starts with empty entries', () => {
    expect(useEntryStore.getState().entries).toEqual([])
  })

  it('starts with isLoading false', () => {
    expect(useEntryStore.getState().isLoading).toBe(false)
  })

  it('starts with null error', () => {
    expect(useEntryStore.getState().error).toBeNull()
  })
})

describe('setEntries', () => {
  it('replaces entries array', () => {
    const entry = makeEntry()
    useEntryStore.getState().setEntries([entry])
    expect(useEntryStore.getState().entries).toHaveLength(1)
    expect(useEntryStore.getState().entries[0].id).toBe('entry-1')
  })

  it('populates entriesById lookup map', () => {
    const entry = makeEntry()
    useEntryStore.getState().setEntries([entry])
    expect(useEntryStore.getState().entriesById['entry-1']).toEqual(entry)
  })

  it('merges into entriesById without dropping previously seen entries', () => {
    const a = makeEntry({ id: 'a', journal_id: 'j1' })
    const b = makeEntry({ id: 'b', journal_id: 'j2' })
    useEntryStore.getState().setEntries([a])
    useEntryStore.getState().setEntries([b])
    // entries array reflects the latest scope
    expect(useEntryStore.getState().entries.map((e) => e.id)).toEqual(['b'])
    // entriesById retains both — so tab titles for entries from other
    // journals don't fall back when the active tab refetches.
    expect(useEntryStore.getState().entriesById['a']).toEqual(a)
    expect(useEntryStore.getState().entriesById['b']).toEqual(b)
  })

  it('overwrites stale entries in entriesById with the newer copy', () => {
    const stale = makeEntry({ id: 'a', title: 'Old' })
    const fresh = makeEntry({ id: 'a', title: 'New' })
    useEntryStore.getState().setEntries([stale])
    useEntryStore.getState().setEntries([fresh])
    expect(useEntryStore.getState().entriesById['a'].title).toBe('New')
  })
})

describe('regression: cross-journal tab switch preserves entry title', () => {
  // Originally reported as: "When I select an entry, the tab title shows
  // the entry title. After switching to another tab, the previous tab's
  // title falls back to 'Entries'."
  // Root cause: tab-title resolution used to read from `entries`, which is
  // wholesale-replaced when `useEntries` refetches for a different journal.
  it("does not drop a tab's entry from entriesById when a different scope is fetched", () => {
    const tabAEntry = makeEntry({ id: 'tabA', journal_id: 'j1', title: 'Hike notes' })
    const tabBEntries = [
      makeEntry({ id: 'tabB-1', journal_id: 'j2' }),
      makeEntry({ id: 'tabB-2', journal_id: 'j2' }),
    ]
    // Tab A's scope loads — selectedEntryId='tabA' is then resolved via
    // entriesById and the tab shows "Hike notes".
    useEntryStore.getState().setEntries([tabAEntry])
    // User switches to Tab B (different journal). useEntries refetches and
    // calls setEntries with j2 entries.
    useEntryStore.getState().setEntries(tabBEntries)
    // The visible list is j2; entriesById must still contain tabA so the
    // inactive Tab A keeps rendering "Hike notes" instead of "Entries".
    expect(useEntryStore.getState().entries.map((e) => e.id)).toEqual(['tabB-1', 'tabB-2'])
    expect(useEntryStore.getState().entriesById['tabA']?.title).toBe('Hike notes')
  })
})

describe('mergeEntries', () => {
  it('merges entries into entriesById without touching the entries array', () => {
    const main = makeEntry({ id: 'main', title: 'Main' })
    const extra = makeEntry({ id: 'extra', title: 'Extra' })
    useEntryStore.getState().setEntries([main])
    useEntryStore.getState().mergeEntries([extra])
    expect(useEntryStore.getState().entries.map((e) => e.id)).toEqual(['main'])
    expect(useEntryStore.getState().entriesById['main']).toEqual(main)
    expect(useEntryStore.getState().entriesById['extra']).toEqual(extra)
  })
})

describe('setLoading', () => {
  it('sets loading to true', () => {
    useEntryStore.getState().setLoading(true)
    expect(useEntryStore.getState().isLoading).toBe(true)
  })

  it('sets loading to false', () => {
    useEntryStore.setState({ isLoading: true })
    useEntryStore.getState().setLoading(false)
    expect(useEntryStore.getState().isLoading).toBe(false)
  })
})

describe('setError', () => {
  it('sets an error message', () => {
    useEntryStore.getState().setError('Something went wrong')
    expect(useEntryStore.getState().error).toBe('Something went wrong')
  })

  it('clears the error', () => {
    useEntryStore.setState({ error: 'Something went wrong' })
    useEntryStore.getState().setError(null)
    expect(useEntryStore.getState().error).toBeNull()
  })
})

describe('addEntry', () => {
  it('adds an entry to the store', () => {
    const entry = makeEntry()
    useEntryStore.getState().addEntry(entry)
    expect(useEntryStore.getState().entries).toHaveLength(1)
  })

  it('also adds the entry to entriesById', () => {
    const entry = makeEntry({ id: 'fresh' })
    useEntryStore.getState().addEntry(entry)
    expect(useEntryStore.getState().entriesById['fresh']).toEqual(entry)
  })

  it('adds multiple entries', () => {
    useEntryStore.getState().addEntry(makeEntry({ id: 'a' }))
    useEntryStore.getState().addEntry(makeEntry({ id: 'b' }))
    expect(useEntryStore.getState().entries).toHaveLength(2)
  })

  it('prepends new entry to the top so newest appears first', () => {
    useEntryStore.setState({ entries: [makeEntry({ id: 'old' })] })
    useEntryStore.getState().addEntry(makeEntry({ id: 'new' }))
    expect(useEntryStore.getState().entries[0].id).toBe('new')
    expect(useEntryStore.getState().entries[1].id).toBe('old')
  })
})

describe('updateEntry', () => {
  it('updates an existing entry by id', () => {
    const entry = makeEntry()
    useEntryStore.setState({ entries: [entry], entriesById: { [entry.id]: entry } })
    useEntryStore.getState().updateEntry({ ...entry, title: 'Updated Title' })
    expect(useEntryStore.getState().entries[0].title).toBe('Updated Title')
  })

  it('also updates entriesById so consumers of the lookup map see the rename', () => {
    const entry = makeEntry({ id: 'a', title: 'Original' })
    useEntryStore.setState({ entries: [entry], entriesById: { a: entry } })
    useEntryStore.getState().updateEntry({ ...entry, title: 'Renamed' })
    expect(useEntryStore.getState().entriesById['a'].title).toBe('Renamed')
  })

  it('updates entriesById even when entry is not in the visible entries array', () => {
    // Simulates an entry that lives in entriesById (cached from a previous
    // journal scope) but is not in the current entries list.
    const entry = makeEntry({ id: 'cached', title: 'Original' })
    useEntryStore.setState({ entries: [], entriesById: { cached: entry } })
    useEntryStore.getState().updateEntry({ ...entry, title: 'Renamed' })
    expect(useEntryStore.getState().entriesById['cached'].title).toBe('Renamed')
  })

  it('does not change length when updating', () => {
    useEntryStore.setState({ entries: [makeEntry({ id: 'a' }), makeEntry({ id: 'b' })] })
    useEntryStore.getState().updateEntry(makeEntry({ id: 'a', title: 'Changed' }))
    expect(useEntryStore.getState().entries).toHaveLength(2)
  })

  it('does not update entries with non-matching id', () => {
    const entry = makeEntry({ id: 'original' })
    useEntryStore.setState({ entries: [entry] })
    useEntryStore.getState().updateEntry(makeEntry({ id: 'other', title: 'Ignored' }))
    expect(useEntryStore.getState().entries[0].title).toBe('Test Entry')
  })
})

describe('removeEntry', () => {
  it('removes an entry by id', () => {
    const e = makeEntry({ id: 'entry-1' })
    useEntryStore.setState({ entries: [e], entriesById: { 'entry-1': e } })
    useEntryStore.getState().removeEntry('entry-1')
    expect(useEntryStore.getState().entries).toHaveLength(0)
  })

  it('only removes the matching entry', () => {
    const a = makeEntry({ id: 'a' })
    const b = makeEntry({ id: 'b' })
    useEntryStore.setState({ entries: [a, b], entriesById: { a, b } })
    useEntryStore.getState().removeEntry('a')
    expect(useEntryStore.getState().entries).toHaveLength(1)
    expect(useEntryStore.getState().entries[0].id).toBe('b')
  })

  it('also removes the entry from entriesById', () => {
    const a = makeEntry({ id: 'a' })
    useEntryStore.setState({ entries: [a], entriesById: { a } })
    useEntryStore.getState().removeEntry('a')
    expect(useEntryStore.getState().entriesById['a']).toBeUndefined()
  })
})
