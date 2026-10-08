import { describe, expect, it } from 'vitest'
import { buildEntryIndex, lwwWinner, newestLive, type ManifestEntryRow } from './entryIndex'

const row = (id: string, updated: number, deleted = false): ManifestEntryRow => ({
  entry_id: id,
  updated_at: updated,
  is_deleted: deleted,
})

describe('buildEntryIndex', () => {
  it('picks the newest updated_at across devices', () => {
    const index = buildEntryIndex([
      { device: 'dev-a', entries: [row('e1', 10), row('e2', 50)] },
      { device: 'dev-b', entries: [row('e1', 20), row('e2', 40)] },
    ])
    expect(index.get('e1')).toMatchObject({ authorDevice: 'dev-b', updatedAt: 20 })
    expect(index.get('e2')).toMatchObject({ authorDevice: 'dev-a', updatedAt: 50 })
  })

  it('breaks an exact tie with the greater device id, whatever the order', () => {
    const a = { device: 'dev-a', entries: [row('e1', 10)] }
    const b = { device: 'dev-b', entries: [row('e1', 10)] }
    expect(buildEntryIndex([a, b]).get('e1')?.authorDevice).toBe('dev-b')
    expect(buildEntryIndex([b, a]).get('e1')?.authorDevice).toBe('dev-b')
  })

  it('lets a newer tombstone beat an older live copy, and the reverse', () => {
    const live = { device: 'dev-a', entries: [row('e1', 10)] }
    const dead = { device: 'dev-b', entries: [row('e1', 20, true)] }
    expect(buildEntryIndex([live, dead]).get('e1')?.isDeleted).toBe(true)
    const newerLive = { device: 'dev-a', entries: [row('e1', 30)] }
    expect(buildEntryIndex([newerLive, dead]).get('e1')?.isDeleted).toBe(false)
  })

  it('lwwWinner is symmetric', () => {
    const x = { entryId: 'e', authorDevice: 'a', updatedAt: 5, isDeleted: false }
    const y = { entryId: 'e', authorDevice: 'b', updatedAt: 5, isDeleted: true }
    expect(lwwWinner(x, y)).toBe(lwwWinner(y, x))
  })

  it('on an exact tie prefers the trashed row over the device-id tiebreak, symmetrically', () => {
    const trashed = { device: 'dev-a', entries: [{ ...row('e1', 10), trashed_at: 9 }] }
    const oldPeerLive = { device: 'dev-z', entries: [row('e1', 10)] }
    expect(buildEntryIndex([trashed, oldPeerLive]).get('e1')).toMatchObject({
      authorDevice: 'dev-a',
      trashedAt: 9,
    })
    expect(buildEntryIndex([oldPeerLive, trashed]).get('e1')?.authorDevice).toBe('dev-a')
    const newerLive = { device: 'dev-b', entries: [row('e1', 11)] }
    expect(buildEntryIndex([trashed, newerLive]).get('e1')?.trashedAt).toBeUndefined()
  })

  it('leaves legacy rows without trashed_at untouched', () => {
    const index = buildEntryIndex([{ device: 'd', entries: [row('e1', 10)] }])
    expect(index.get('e1')).toEqual({
      entryId: 'e1',
      authorDevice: 'd',
      updatedAt: 10,
      isDeleted: false,
    })
  })
})

describe('newestLive', () => {
  it('excludes tombstones and trashed rows, orders by updated_at desc then id asc, and limits', () => {
    const index = buildEntryIndex([
      {
        device: 'd',
        entries: [
          row('b', 5),
          row('a', 5),
          row('c', 9),
          row('dead', 100, true),
          { ...row('trashed', 100), trashed_at: 50 },
          row('old', 1),
        ],
      },
    ])
    expect(newestLive(index, 3).map((e) => e.entryId)).toEqual(['c', 'a', 'b'])
    expect(newestLive(index, 0)).toEqual([])
  })
})
