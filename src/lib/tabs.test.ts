import { describe, it, expect } from 'vitest'
import { labelForView, titleForTab } from './tabs'
import { makeDefaultTab, type Tab } from '../stores/tabStore'
import type { Journal } from '../types/journal'
import type { Entry } from '../types/entry'

const makeJournal = (overrides: Partial<Journal> = {}): Journal => ({
  id: 'j1',
  name: 'My Journal',
  color: null,
  created_at: 1700000000,
  updated_at: 1700000000,
  sort_order: 0,
  is_deleted: false,
  is_locked: false,
  is_invisible: false,
  vault_id: null,
  is_initial_placeholder: false,
  ...overrides,
})

const makeEntry = (overrides: Partial<Entry> = {}): Entry => ({
  id: 'e1',
  journal_id: 'j1',
  title: 'My Entry',
  preview_text: null,
  content_text: null,
  entry_date: 1700000000,
  created_at: 1700000000,
  updated_at: 1700000000,
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

const makeTab = (overrides: Partial<Tab> = {}): Tab => ({
  ...makeDefaultTab(),
  id: 't1',
  journalId: 'j1',
  ...overrides,
})

describe('labelForView', () => {
  it('returns "Calendar" for calendar view', () => {
    expect(labelForView('calendar')).toBe('Calendar')
  })

  it('returns "Tags" for tags view', () => {
    expect(labelForView('tags')).toBe('Tags')
  })

  it('returns "Search" for search view', () => {
    expect(labelForView('search')).toBe('Search')
  })

  it('returns "Settings" for settings view', () => {
    expect(labelForView('settings')).toBe('Settings')
  })

  it('returns "Entries" for entries view', () => {
    expect(labelForView('entries')).toBe('Entries')
  })
})

describe('titleForTab', () => {
  describe('when activeView is entries with an entry selected', () => {
    it('returns entry title when entry has a title', () => {
      const tab = makeTab({ activeView: 'entries', selectedEntryId: 'e1' })
      const journal = makeJournal()
      const entry = makeEntry({ title: 'Hello World' })
      expect(titleForTab(tab, journal, entry)).toBe('Hello World')
    })

    it('returns "Untitled" when entry title is null', () => {
      const tab = makeTab({ activeView: 'entries', selectedEntryId: 'e1' })
      const journal = makeJournal()
      const entry = makeEntry({ title: null })
      expect(titleForTab(tab, journal, entry)).toBe('Untitled')
    })

    it('returns "Untitled" when entry title is empty string', () => {
      const tab = makeTab({ activeView: 'entries', selectedEntryId: 'e1' })
      const journal = makeJournal()
      const entry = makeEntry({ title: '' })
      expect(titleForTab(tab, journal, entry)).toBe('Untitled')
    })
  })

  describe('when activeView is entries with no entry', () => {
    it('returns "Entries" regardless of journal', () => {
      const tab = makeTab({ activeView: 'entries', selectedEntryId: null })
      const journal = makeJournal({ name: 'Work' })
      expect(titleForTab(tab, journal, null)).toBe('Entries')
    })

    it('returns "Entries" when journal is null', () => {
      const tab = makeTab({ activeView: 'entries', selectedEntryId: null })
      expect(titleForTab(tab, null, null)).toBe('Entries')
    })
  })

  describe('when activeView is not entries', () => {
    it('returns "Calendar" for calendar view', () => {
      const tab = makeTab({ activeView: 'calendar' })
      const journal = makeJournal({ name: 'Personal' })
      expect(titleForTab(tab, journal, null)).toBe('Calendar')
    })

    it('returns "Search" for search view with no journal', () => {
      const tab = makeTab({ activeView: 'search' })
      expect(titleForTab(tab, null, null)).toBe('Search')
    })

    it('returns "Tags" for tags view', () => {
      const tab = makeTab({ activeView: 'tags' })
      const journal = makeJournal({ name: 'Work' })
      expect(titleForTab(tab, journal, null)).toBe('Tags')
    })

    it('returns "Settings" for settings view', () => {
      const tab = makeTab({ activeView: 'settings' })
      const journal = makeJournal({ name: 'My Journal' })
      expect(titleForTab(tab, journal, null)).toBe('Settings')
    })

    it('ignores entry argument for non-entries views', () => {
      const tab = makeTab({ activeView: 'search' })
      const journal = makeJournal({ name: 'Journal' })
      const entry = makeEntry()
      expect(titleForTab(tab, journal, entry)).toBe('Search')
    })
  })
})
