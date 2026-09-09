import type { Journal } from '../../src/types/journal'

// Base timestamps in epoch seconds
const now = Math.floor(Date.now() / 1000)
const oneMonthAgo = now - 30 * 24 * 60 * 60
const twoMonthsAgo = now - 60 * 24 * 60 * 60

export const JOURNAL_DAILY_ID = 'journal-daily-0001'
export const JOURNAL_WORK_ID = 'journal-work-0002'
export const JOURNAL_TRAVEL_ID = 'journal-travel-0003'
export const JOURNAL_PRIVATE_ID = 'journal-private-0004'

export const journals: Journal[] = [
  {
    id: JOURNAL_DAILY_ID,
    name: 'Daily Journal',
    color: '#8B5CF6',
    created_at: twoMonthsAgo,
    updated_at: now,
    sort_order: 0,
    is_deleted: false,
    is_locked: false,
    is_invisible: false,
    vault_id: null,
    is_initial_placeholder: false,
  },
  {
    id: JOURNAL_WORK_ID,
    name: 'Work Notes',
    color: '#3B82F6',
    created_at: twoMonthsAgo,
    updated_at: now - 2 * 24 * 60 * 60,
    sort_order: 1,
    is_deleted: false,
    is_locked: false,
    is_invisible: false,
    vault_id: null,
    is_initial_placeholder: false,
  },
  {
    id: JOURNAL_TRAVEL_ID,
    name: 'My Adventures Around The World',
    color: '#10B981',
    created_at: oneMonthAgo,
    updated_at: now - 7 * 24 * 60 * 60,
    sort_order: 2,
    is_deleted: false,
    is_locked: false,
    is_invisible: false,
    vault_id: null,
    is_initial_placeholder: false,
  },
  {
    id: JOURNAL_PRIVATE_ID,
    name: 'Health & Personal',
    color: '#F43F5E',
    created_at: twoMonthsAgo,
    updated_at: now - 3 * 24 * 60 * 60,
    sort_order: 3,
    is_deleted: false,
    is_locked: true,
    is_invisible: false,
    vault_id: null,
    is_initial_placeholder: false,
  },
]
