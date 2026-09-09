import { describe, it, expect, beforeEach } from 'vitest'
import { useJournalStore } from './journalStore'
import type { Journal } from '../types/journal'

const makeJournal = (overrides: Partial<Journal> = {}): Journal => ({
  id: 'journal-1',
  name: 'My Journal',
  color: null,
  created_at: 1744640400000,
  updated_at: 1744640400000,
  sort_order: 0,
  is_deleted: false,
  is_locked: false,
  is_invisible: false,
  vault_id: null,
  is_initial_placeholder: false,
  ...overrides,
})

beforeEach(() => {
  useJournalStore.setState({
    journals: [],
    activeJournalId: null,
  })
})

describe('journalStore — initial state', () => {
  it('starts with empty journals', () => {
    expect(useJournalStore.getState().journals).toEqual([])
  })

  it('starts with null activeJournalId', () => {
    expect(useJournalStore.getState().activeJournalId).toBeNull()
  })
})

describe('setJournals', () => {
  it('sets journals array', () => {
    const journal = makeJournal()
    useJournalStore.getState().setJournals([journal])
    expect(useJournalStore.getState().journals).toHaveLength(1)
    expect(useJournalStore.getState().journals[0].id).toBe('journal-1')
  })

  it('replaces existing journals', () => {
    useJournalStore.setState({ journals: [makeJournal({ id: 'old' })] })
    useJournalStore.getState().setJournals([makeJournal({ id: 'new' })])
    expect(useJournalStore.getState().journals).toHaveLength(1)
    expect(useJournalStore.getState().journals[0].id).toBe('new')
  })
})

describe('setActiveJournalId', () => {
  it('sets active journal id', () => {
    useJournalStore.getState().setActiveJournalId('journal-1')
    expect(useJournalStore.getState().activeJournalId).toBe('journal-1')
  })

  it('can clear active journal id', () => {
    useJournalStore.setState({ activeJournalId: 'journal-1' })
    useJournalStore.getState().setActiveJournalId(null)
    expect(useJournalStore.getState().activeJournalId).toBeNull()
  })
})
