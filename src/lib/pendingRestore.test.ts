import { describe, it, expect, beforeEach } from 'vitest'
import { setPendingRestore, getPendingRestore } from './pendingRestore'

beforeEach(() => {
  setPendingRestore(null)
})

describe('setPendingRestore / getPendingRestore', () => {
  it('returns null when nothing is pending', () => {
    expect(getPendingRestore()).toBeNull()
  })

  it('returns the detail after it is set', () => {
    setPendingRestore({ entryId: 'entry-1', versionId: 'version-1' })
    expect(getPendingRestore()).toEqual({ entryId: 'entry-1', versionId: 'version-1' })
  })

  it('overwrites a previously pending detail', () => {
    setPendingRestore({ entryId: 'entry-1', versionId: 'version-1' })
    setPendingRestore({ entryId: 'entry-2', versionId: 'version-2' })
    expect(getPendingRestore()).toEqual({ entryId: 'entry-2', versionId: 'version-2' })
  })

  it('clears back to null', () => {
    setPendingRestore({ entryId: 'entry-1', versionId: 'version-1' })
    setPendingRestore(null)
    expect(getPendingRestore()).toBeNull()
  })
})
