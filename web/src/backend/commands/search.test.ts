import { afterEach, describe, expect, it } from 'vitest'
import type { SearchResult } from '../../../../src/types/entry'
import { dispose, lock, setKeyRing, type KeyRing } from '../keys'
import { configureReadEnv } from './readSession'
import { installFakeSession, type FakeSpec } from './readTestKit'
import { SEARCH_LIMIT, cancelSearchScan, searchHandlers, whenSearchScanSettled } from './search'

afterEach(() => {
  cancelSearchScan()
  configureReadEnv({})
})

const search = (query: string, extra: Record<string, unknown> = {}): Promise<SearchResult[]> =>
  Promise.resolve(
    searchHandlers.search_entries({
      query,
      filters: undefined,
      lockedView: 'revealed',
      activeVaultId: null,
      mentionMode: false,
      ...extra,
    }),
  ) as Promise<SearchResult[]>

const ids = (rows: SearchResult[]): string[] => rows.map((r) => r.id)

const SPECS: FakeSpec[] = [
  { id: 'a', updatedAt: 9, entryDate: 10, title: 'Trip to Paris', text: 'sunny day' },
  { id: 'b', updatedAt: 8, entryDate: 30, title: 'Notes', text: 'Việt Nam trip', journal: 'j2' },
  { id: 'c', updatedAt: 7, entryDate: 20, title: 'Plain', text: 'nothing here', emotion: 'good' },
  { id: 'd', updatedAt: 6, entryDate: 40, title: 'Late trip', text: 'x', tags: ['t1'], media: 1 },
  { id: 'e', updatedAt: 5, entryDate: 50, title: 'Hidden trip', locked: true },
]

describe('search_entries', () => {
  it('answers from the loaded set at once, newest entry date first', async () => {
    const { vault } = installFakeSession(SPECS)
    await vault.load(['a', 'b'])
    vault.loadCalls.length = 0
    const rows = await search('trip')
    expect(ids(rows)).toEqual(['b', 'a'])
    expect(rows[0]).toEqual({
      id: 'b',
      journal_id: 'j2',
      title: 'Notes',
      preview_text: 'preview',
      entry_date: 30,
    })
  })

  it('then pulls the remaining text payloads in the background and announces new hits', async () => {
    const { vault, emitted } = installFakeSession(SPECS)
    await vault.load(['a'])
    vault.loadCalls.length = 0
    expect(ids(await search('trip'))).toEqual(['a'])
    await whenSearchScanSettled()
    expect(vault.loadedIds.sort()).toEqual(['a', 'b', 'c', 'd'])
    // 12 ids per batch: one batch holds every remaining entry (the locked one is a stub).
    expect(vault.loadCalls).toHaveLength(1)
    expect(emitted).toEqual(['memlore:entries-changed'])
    expect(ids(await search('trip'))).toEqual(['d', 'b', 'a'])
  })

  it('emits nothing when the background scan finds no new hit', async () => {
    const { emitted } = installFakeSession(SPECS)
    expect(await search('zzzzz')).toEqual([])
    await whenSearchScanSettled()
    expect(emitted).toEqual([])
  })

  it('never lists the locked entry, loaded or not', async () => {
    installFakeSession(SPECS)
    await search('hidden')
    await whenSearchScanSettled()
    expect(await search('hidden')).toEqual([])
    expect(await search('trip')).not.toContainEqual(expect.objectContaining({ id: 'e' }))
  })

  it('matches accent-insensitively and treats a blank query as nothing', async () => {
    const { vault } = installFakeSession(SPECS)
    await vault.load(['b'])
    expect(ids(await search('viet'))).toEqual(['b'])
    expect(ids(await search('Việt'))).toEqual(['b'])
    expect(await search('   ')).toEqual([])
    expect(await search('!!!')).toEqual([])
  })

  it('blank query: with filters it lists the filtered loaded set, without them it cancels and stops', async () => {
    const { vault } = installFakeSession(SPECS)
    await vault.load(['a', 'b', 'c', 'd'])
    const filtered = await search('', { filters: { emotions: ['good'] } })
    expect(ids(filtered)).toEqual(['c'])
    expect(ids(await search('', { filters: { journalIds: ['j2'] } }))).toEqual(['b'])
    expect(ids(await search('', { filters: { tagIds: ['t1', 'other'] } }))).toEqual(['d'])
    expect(ids(await search('', { filters: { hasMedia: 'has' } }))).toEqual(['d'])
    expect(
      ids(await search('', { filters: { timeRange: { from: 15, toExclusive: 35 } } })),
    ).toEqual(['b', 'c'])
    expect(await search('', { filters: {} })).toEqual([])
  })

  it('combines a query with filters', async () => {
    const { vault } = installFakeSession(SPECS)
    await vault.load(['a', 'b', 'd'])
    expect(ids(await search('trip', { filters: { journalIds: ['j2'] } }))).toEqual(['b'])
  })

  it('mention mode prefix-matches the last token and ranks title matches first', async () => {
    const { vault } = installFakeSession([
      { id: 'body', updatedAt: 2, entryDate: 99, title: 'Other', text: 'a parisian morning' },
      { id: 'title', updatedAt: 1, entryDate: 1, title: 'Paris', text: 'x' },
    ])
    await vault.load(['body', 'title'])
    expect(await search('paris')).toHaveLength(1)
    expect(ids(await search('paris', { mentionMode: true }))).toEqual(['title', 'body'])
  })

  it('caps results at the desktop limit of 50', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      id: `m${i}`,
      updatedAt: i,
      entryDate: i,
      text: 'needle',
    }))
    const { vault } = installFakeSession(many)
    await vault.load(many.map((m) => m.id))
    const rows = await search('needle')
    expect(rows).toHaveLength(SEARCH_LIMIT)
    expect(rows[0].id).toBe('m59')
  })

  it('a new (here blank) search cancels the running scan after its in-flight batch', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, updatedAt: 100 - i }))
    const { vault } = installFakeSession(many)
    const real = vault.load
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    ;(vault as { load: typeof real }).load = async (batch) => {
      await gate
      return real(batch)
    }
    await search('anything') // the first background batch is now waiting on the gate
    expect(await search('')).toEqual([]) // a new search: cancels the scan
    release()
    await whenSearchScanSettled()
    expect(vault.loadCalls).toHaveLength(1)
    expect(vault.loadedIds).toHaveLength(12)
  })

  it('a lock hook cancels the scan even when the session reports unlocked again at once', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, updatedAt: 100 - i }))
    const { vault } = installFakeSession(many) // isUnlocked stays true: a quick re-unlock
    const real = vault.load
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    ;(vault as { load: typeof real }).load = async (batch) => {
      await gate
      return real(batch)
    }
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    try {
      await search('anything')
      lock('manual')
      release()
      await whenSearchScanSettled()
      expect(vault.loadCalls).toHaveLength(1)
    } finally {
      dispose()
    }
  })

  it('cancelSearchScan and a lock stop further fetches', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, updatedAt: 100 - i }))
    const { vault } = installFakeSession(many)
    const real = vault.load
    ;(vault as { load: typeof real }).load = async (batch) => {
      const result = await real(batch)
      cancelSearchScan()
      return result
    }
    await search('x')
    await whenSearchScanSettled()
    expect(vault.loadCalls).toHaveLength(1)

    const second = installFakeSession(many)
    const realSecond = second.vault.load
    ;(second.vault as { load: typeof realSecond }).load = async (batch) => {
      const result = await realSecond(batch)
      second.setUnlocked(false)
      return result
    }
    await search('x')
    await whenSearchScanSettled()
    expect(second.vault.loadCalls).toHaveLength(1)
  })

  it('rejects when locked and downloads nothing', async () => {
    const { vault, setUnlocked } = installFakeSession(SPECS)
    setUnlocked(false)
    await expect(search('trip')).rejects.toThrow('vault is locked')
    expect(vault.loadCalls).toEqual([])
  })
})
