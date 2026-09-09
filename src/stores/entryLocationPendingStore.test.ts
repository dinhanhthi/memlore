import { beforeEach, describe, expect, it } from 'vitest'

import { useEntryLocationPendingStore } from './entryLocationPendingStore'

beforeEach(() => {
  useEntryLocationPendingStore.setState({ pendingIds: new Set() })
})

describe('entryLocationPendingStore', () => {
  it('starts with no pending entries', () => {
    expect(useEntryLocationPendingStore.getState().isPending('entry-1')).toBe(false)
  })

  it('marks an entry pending on begin', () => {
    useEntryLocationPendingStore.getState().begin('entry-1')

    expect(useEntryLocationPendingStore.getState().isPending('entry-1')).toBe(true)
    expect(useEntryLocationPendingStore.getState().isPending('entry-2')).toBe(false)
  })

  it('clears only the ended entry', () => {
    const store = useEntryLocationPendingStore.getState()
    store.begin('entry-1')
    store.begin('entry-2')
    store.end('entry-1')

    expect(store.isPending('entry-1')).toBe(false)
    expect(useEntryLocationPendingStore.getState().isPending('entry-2')).toBe(true)
  })
})
