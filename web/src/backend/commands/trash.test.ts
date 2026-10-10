import { afterEach, describe, expect, it } from 'vitest'
import type { Entry } from '../../../../src/types/entry'
import type { OutboxEntryV1 } from '../sync/outbox'
import type { WebDb } from '../storage/idb'
import { configureReadEnv } from './readSession'
import { installFakeSession, type FakeSpec } from './readTestKit'
import { trashHandlers } from './trash'

afterEach(() => {
  configureReadEnv({})
})

const listTrashed = (args: Record<string, unknown> = {}): Promise<Entry[]> =>
  Promise.resolve(trashHandlers.list_trashed_entries(args)) as Promise<Entry[]>

/** A stored `d-<entryId>` trash draft requested at `updatedAtMs` (the sealed bytes are not read). */
async function putTrashDraft(db: WebDb, entryId: string, updatedAtMs: number): Promise<void> {
  await db.drafts.put({
    entryId: `d-${entryId}`,
    kind: 'trash',
    sealed: new Uint8Array([2]),
    updatedAt: updatedAtMs,
  })
}

describe('list_trashed_entries', () => {
  it('lists desktop-Trash entries as deleted rows with their trashed_at, newest first', async () => {
    const specs: FakeSpec[] = [
      { id: 'a', updatedAt: 10, title: 'Older', trashedAt: 500 },
      { id: 'b', updatedAt: 11, title: 'Newer', trashedAt: 900 },
      { id: 'live', updatedAt: 12, title: 'Live' },
    ]
    const { vault } = installFakeSession(specs)

    const rows = await listTrashed()

    expect(vault.loadTrashedCalls).toEqual([['a', 'b']])
    expect(rows.map((e) => [e.id, e.title, e.trashed_at])).toEqual([
      ['b', 'Newer', 900],
      ['a', 'Older', 500],
    ])
    for (const row of rows) {
      expect(row.is_deleted).toBe(true)
      expect(row.is_locked).toBe(false)
      expect(row.is_invisible).toBe(false)
      expect(row).not.toHaveProperty('trash_pending_desktop')
    }
  })

  it('breaks a trashed_at tie by ascending id, as the desktop does', async () => {
    installFakeSession([
      { id: 'z', updatedAt: 1, trashedAt: 700 },
      { id: 'm', updatedAt: 2, trashedAt: 700 },
    ])
    expect((await listTrashed()).map((e) => e.id)).toEqual(['m', 'z'])
  })

  it('lists a pending web delete from its draft, with the request time and the pending flag', async () => {
    const { vault, db } = installFakeSession([{ id: 'p', updatedAt: 10, title: 'Pending' }])
    await vault.load(['p'])
    await putTrashDraft(db, 'p', 1_700_000_000_999)
    vault.setTrashedIds(['p'])

    const [row] = await listTrashed()

    expect(row).toMatchObject({
      id: 'p',
      title: 'Pending',
      is_deleted: true,
      trashed_at: 1_700_000_000,
      trash_pending_desktop: true,
    })
  })

  it('ignores drafts that are not trash drafts', async () => {
    const { db } = installFakeSession([{ id: 'e', updatedAt: 10 }])
    await db.drafts.put({ entryId: 'e', sealed: new Uint8Array([1]), updatedAt: 1000 })
    await db.drafts.put({
      entryId: 'j-x',
      kind: 'journal',
      sealed: new Uint8Array([2]),
      updatedAt: 1,
    })
    expect(await listTrashed()).toEqual([])
  })

  it('shows an id pending AND in the desktop Trash once, as the desktop row', async () => {
    const { vault, db } = installFakeSession([{ id: 'x', updatedAt: 10, trashedAt: 800 }])
    await putTrashDraft(db, 'x', 1_700_000_000_000)
    vault.setTrashedIds(['x'])

    const rows = await listTrashed()

    expect(rows).toHaveLength(1)
    expect(rows[0].trashed_at).toBe(800)
    expect(rows[0]).not.toHaveProperty('trash_pending_desktop')
  })

  it('loads the synced copy of a pending delete that is not in RAM', async () => {
    const { vault, db } = installFakeSession([{ id: 'p', updatedAt: 10, title: 'Reloaded' }])
    await putTrashDraft(db, 'p', 5000)
    vault.setTrashedIds(['p'])

    const rows = await listTrashed()

    expect(vault.loadCalls).toEqual([['p']])
    expect(rows.map((e) => [e.id, e.title])).toEqual([['p', 'Reloaded']])
  })

  it('serves a pending web-created entry from its intent without loading', async () => {
    const { vault, db } = installFakeSession([])
    vault.setOutboxIntents([
      {
        entry_id: 'w',
        created_on_web: true,
        web_device_id: 'web',
        web_updated_at_secs: 100,
        fields: { title: { value: 'Made on web' } },
        yjs_full_state: [],
      } as unknown as OutboxEntryV1,
    ])
    await putTrashDraft(db, 'w', 9000)
    vault.setTrashedIds(['w'])

    const rows = await listTrashed()

    expect(vault.loadCalls).toEqual([])
    expect(rows.map((e) => [e.id, e.title, e.trash_pending_desktop])).toEqual([
      ['w', 'Made on web', true],
    ])
  })

  it('lists a pending id with nothing to show as an untitled row', async () => {
    const { vault, db } = installFakeSession([])
    await putTrashDraft(db, 'gone', 3000)
    vault.setTrashedIds(['gone'])

    const rows = await listTrashed()

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 'gone',
      title: null,
      is_deleted: true,
      trashed_at: 3,
      trash_pending_desktop: true,
      media_count: 0,
    })
  })

  it('leaves out locked, invisible and journal-excluded entries, desktop or pending', async () => {
    const { vault, db } = installFakeSession([
      { id: 'dl', updatedAt: 1, trashedAt: 10, locked: true },
      { id: 'di', updatedAt: 2, trashedAt: 20, invisible: true },
      { id: 'dj', updatedAt: 3, trashedAt: 30, journal: 'secret' },
      { id: 'pl', updatedAt: 4, locked: true },
      { id: 'pi', updatedAt: 5, invisible: true },
      { id: 'pj', updatedAt: 6, journal: 'secret' },
      { id: 'ok', updatedAt: 7, trashedAt: 40 },
    ])
    vault.excludedJournals.add('secret')
    for (const id of ['pl', 'pi', 'pj']) await putTrashDraft(db, id, 1000)
    vault.setTrashedIds(['pl', 'pi', 'pj'])

    expect((await listTrashed()).map((e) => e.id)).toEqual(['ok'])
  })

  it('ignores the lockedView and activeVaultId arguments', async () => {
    installFakeSession([{ id: 'a', updatedAt: 1, trashedAt: 10 }])
    const plain = await listTrashed()
    const revealed = await listTrashed({ lockedView: 'revealed', activeVaultId: 'v1' })
    expect(revealed).toEqual(plain)
    expect(plain.map((e) => e.id)).toEqual(['a'])
  })

  it('orders pending and desktop rows together by trashed_at', async () => {
    const { vault, db } = installFakeSession([
      { id: 'd', updatedAt: 1, trashedAt: 2_000 },
      { id: 'p', updatedAt: 2 },
    ])
    await vault.load(['p'])
    await putTrashDraft(db, 'p', 3_000_000)
    vault.setTrashedIds(['p'])
    expect((await listTrashed()).map((e) => e.id)).toEqual(['p', 'd'])
  })

  it('does not list a pending web-created entry of an excluded journal as untitled', async () => {
    const { vault, db } = installFakeSession([])
    vault.setOutboxIntents([
      {
        entry_id: 'w',
        created_on_web: true,
        web_device_id: 'web',
        web_updated_at_secs: 100,
        fields: { title: { value: 'Hidden' }, journal_id: { value: 'secret' } },
        yjs_full_state: [],
      } as unknown as OutboxEntryV1,
    ])
    vault.excludedJournals.add('secret')
    await putTrashDraft(db, 'w', 9000)
    vault.setTrashedIds(['w'])

    expect(await listTrashed()).toEqual([])
  })
})
