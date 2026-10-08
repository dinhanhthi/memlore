import { describe, expect, it } from 'vitest'
import { isEntryInTrash, isTrashedEntryError, shouldResaveAfterRestore } from './trashedEntryError'

describe('isTrashedEntryError', () => {
  it('matches the backend string rejection', () => {
    expect(isTrashedEntryError('entry is in Trash; restore it to edit')).toBe(true)
  })

  it('matches an Error carrying the message with a prefix', () => {
    expect(
      isTrashedEntryError(new Error('save failed: entry is in Trash; restore it to edit')),
    ).toBe(true)
  })

  it('rejects other errors', () => {
    expect(isTrashedEntryError('database is locked')).toBe(false)
    expect(isTrashedEntryError(new Error('Auto-save failed'))).toBe(false)
    expect(isTrashedEntryError(undefined)).toBe(false)
  })
})

describe('isEntryInTrash', () => {
  it('is in Trash only when deleted with a trashed_at', () => {
    expect(isEntryInTrash({ is_deleted: true, trashed_at: 1_700_000_000 })).toBe(true)
  })

  it('treats a live row with a stale trashed_at as live (downgrade)', () => {
    expect(isEntryInTrash({ is_deleted: false, trashed_at: 1_700_000_000 })).toBe(false)
  })

  it('treats a live row or a tombstone without trashed_at as not in Trash', () => {
    expect(isEntryInTrash({ is_deleted: false, trashed_at: null })).toBe(false)
    expect(isEntryInTrash({ is_deleted: true, trashed_at: null })).toBe(false)
    expect(isEntryInTrash({ is_deleted: false })).toBe(false)
  })
})

describe('shouldResaveAfterRestore', () => {
  it('re-saves once a rejected entry is live again', () => {
    expect(shouldResaveAfterRestore(true, { is_deleted: false, trashed_at: null })).toBe(true)
    expect(shouldResaveAfterRestore(true, { is_deleted: false })).toBe(true)
  })

  it('re-saves a live row that kept a stale trashed_at', () => {
    expect(shouldResaveAfterRestore(true, { is_deleted: false, trashed_at: 1_700_000_000 })).toBe(
      true,
    )
  })

  it('waits while the entry is still in Trash', () => {
    expect(shouldResaveAfterRestore(true, { is_deleted: true, trashed_at: 1_700_000_000 })).toBe(
      false,
    )
  })

  it('never re-saves a purged tombstone (deleted, no trashed_at)', () => {
    expect(shouldResaveAfterRestore(true, { is_deleted: true, trashed_at: null })).toBe(false)
    expect(shouldResaveAfterRestore(true, { is_deleted: true })).toBe(false)
  })

  it('does nothing when no write was rejected', () => {
    expect(shouldResaveAfterRestore(false, { is_deleted: false, trashed_at: null })).toBe(false)
  })
})
