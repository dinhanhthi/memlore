import { afterEach, describe, expect, it } from 'vitest'
import type { Core } from '../../core/core'
import type { Tag } from '../../../../src/types/journal'
import type { KeyRing } from '../keys'
import type { MetaRecord, WebDb } from '../storage/idb'
import { configureReadEnv, readTaxonomy, type Taxonomy } from './readSession'
import { EMPTY_TAXONOMY, installFakeSession } from './readTestKit'
import { taxonomyHandlers } from './taxonomy'

afterEach(() => configureReadEnv({}))

const call = <T>(name: string, args: Record<string, unknown> = {}): Promise<T> =>
  Promise.resolve(taxonomyHandlers[name](args)) as Promise<T>

const journal = (id: string, sort: number) => ({
  id,
  name: `Journal ${id}`,
  color: null,
  created_at: sort,
  updated_at: sort,
  sort_order: sort,
  is_deleted: false,
  is_locked: false,
  is_invisible: false,
  vault_id: null,
  is_initial_placeholder: false,
})

const tag = (id: string, name: string): Tag => ({ id, name, color: null })

const TAXONOMY: Taxonomy = {
  ...EMPTY_TAXONOMY,
  journals: [journal('j1', 1), journal('j2', 2)],
  autoTagIds: { j1: ['t2', 't1'] },
  tags: [tag('t1', 'alpha'), tag('t2', 'beta'), tag('t3', 'gamma')],
  templates: [
    {
      id: 'tp1',
      name: 'Daily',
      description: null,
      content: [1, 2],
      is_predefined: false,
      sort_order: 0,
      created_at: 1,
    },
  ],
}

describe('taxonomy handlers', () => {
  it('serves journals, auto tags, tags and templates read-only', async () => {
    installFakeSession([], { taxonomy: TAXONOMY })
    expect((await call<Array<{ id: string }>>('list_journals')).map((j) => j.id)).toEqual([
      'j1',
      'j2',
    ])
    expect(await call('get_journal', { id: 'j2' })).toMatchObject({ id: 'j2' })
    expect(await call('get_journal', { id: 'hidden' })).toBeNull()
    expect(await call('list_journal_auto_tags', { journalId: 'j1' })).toEqual([
      tag('t1', 'alpha'),
      tag('t2', 'beta'),
    ])
    expect(await call('list_journal_auto_tags', { journalId: 'j2' })).toEqual([])
    expect(await call('list_tags')).toEqual(TAXONOMY.tags)
    expect(await call('list_templates')).toEqual(TAXONOMY.templates)
    expect(await call('get_template', { id: 'tp1' })).toEqual(TAXONOMY.templates[0])
    expect(await call('get_template', { id: 'nope' })).toBeNull()
  })

  it('counts tags over the loaded visible entries, count desc then name', async () => {
    const { vault } = installFakeSession(
      [
        { id: 'a', updatedAt: 3, tags: ['t2'] },
        { id: 'b', updatedAt: 2, tags: ['t2', 't3'] },
        { id: 'c', updatedAt: 1, tags: ['t1'], locked: true },
      ],
      { taxonomy: TAXONOMY },
    )
    await vault.load(['a', 'b', 'c'])
    expect(await call('get_tags_with_counts')).toEqual([
      [tag('t2', 'beta'), 2],
      [tag('t3', 'gamma'), 1],
      [tag('t1', 'alpha'), 0],
    ])
  })

  it('gets the tags of one entry on demand and of many without downloading', async () => {
    const { vault } = installFakeSession(
      [
        { id: 'a', updatedAt: 3, tags: ['t2', 't1'] },
        { id: 'b', updatedAt: 2, tags: ['t3'] },
        { id: 'l', updatedAt: 1, tags: ['t1'], locked: true },
      ],
      { taxonomy: TAXONOMY },
    )
    expect(await call('get_tags_for_entry', { entryId: 'a' })).toEqual([
      tag('t1', 'alpha'),
      tag('t2', 'beta'),
    ])
    expect(vault.loadCalls).toEqual([['a']])
    // Hidden or unknown entries answer an empty list, as on desktop.
    expect(await call('get_tags_for_entry', { entryId: 'l' })).toEqual([])
    expect(await call('get_tags_for_entry', { entryId: 'nope' })).toEqual([])

    vault.loadCalls.length = 0
    expect(await call('get_tags_for_entries', { entryIds: ['a', 'b', 'l', 'nope'] })).toEqual({
      a: [tag('t1', 'alpha'), tag('t2', 'beta')],
    })
    expect(vault.loadCalls).toEqual([])
  })

  it('answers journal ids and entry ids named like Object.prototype keys', async () => {
    const { vault } = installFakeSession([{ id: '__proto__', updatedAt: 1, tags: ['t1'] }], {
      taxonomy: TAXONOMY,
    })
    expect(await call('list_journal_auto_tags', { journalId: '__proto__' })).toEqual([])
    expect(await call('list_journal_auto_tags', { journalId: 'toString' })).toEqual([])
    await vault.load(['__proto__'])
    const out = await call<Record<string, Tag[]>>('get_tags_for_entries', {
      entryIds: ['__proto__'],
    })
    expect(Object.keys(out)).toEqual(['__proto__'])
    expect(out['__proto__']).toEqual([tag('t1', 'alpha')])
  })

  it('rejects every handler when locked', async () => {
    const { setUnlocked } = installFakeSession([], { taxonomy: TAXONOMY })
    setUnlocked(false)
    for (const name of Object.keys(taxonomyHandlers)) {
      await expect(
        call(name, { id: 'x', journalId: 'j1', entryId: 'a', entryIds: [] }),
      ).rejects.toThrow('vault is locked')
    }
  })
})

describe('readTaxonomy (merge across devices)', () => {
  function build(
    files: Record<string, unknown>,
    metaStore = new Map<string, MetaRecord>(),
  ): { db: WebDb; core: Core; metaStore: Map<string, MetaRecord> } {
    const enc = new TextEncoder()
    const db = {
      files: {
        paths: async () => Object.keys(files),
        get: async (path: string) => ({ ciphertext: enc.encode(JSON.stringify(files[path])) }),
      },
      meta: {
        listByPrefix: async (prefix: string) =>
          [...metaStore.values()].filter((r) => r.key.startsWith(prefix)),
        put: async (record: MetaRecord) => {
          metaStore.set(record.key, record)
        },
      },
    } as unknown as WebDb
    const core = { openDeviceBin: (_ring: KeyRing, bytes: Uint8Array) => bytes } as unknown as Core
    return { db, core, metaStore }
  }
  const ring = {} as KeyRing

  const journalFile = (device: string, patch: Record<string, unknown>) => ({
    journal_id: 'j1',
    device_id: device,
    name: 'Journal',
    color: null,
    sort_order: 1,
    is_deleted: false,
    created_at: 1,
    updated_at: 10,
    ...patch,
  })

  it('takes the newest journal copy and excludes locked and invisible journals', async () => {
    const { db, core } = build({
      'devA/journals/j1.bin': journalFile('devA', { name: 'Old', updated_at: 5 }),
      'devB/journals/j1.bin': journalFile('devB', {
        name: 'New',
        updated_at: 9,
        auto_tag_ids: ['t1'],
      }),
      'devA/journals/j2.bin': journalFile('devA', { journal_id: 'j2', is_locked: true }),
      'devA/journals/j3.bin': journalFile('devA', { journal_id: 'j3', is_invisible: true }),
      'devA/journals/j4.bin': journalFile('devA', { journal_id: 'j4', is_deleted: true }),
      '.meta/journals/zz.bin': journalFile('x', { journal_id: 'ignored' }),
    })
    const taxonomy = await readTaxonomy(db, core, ring)
    expect(taxonomy.journals.map((j) => [j.id, j.name])).toEqual([['j1', 'New']])
    expect(taxonomy.journals[0]).not.toHaveProperty('autoTagIds')
    expect(taxonomy.autoTagIds.j1).toEqual(['t1'])
    expect(taxonomy.excludedJournalIds.sort()).toEqual(['j2', 'j3'])
  })

  it('merges tags and templates by id and drops tombstones', async () => {
    const { db, core } = build({
      'devA/tags.bin': {
        tags: [
          { id: 't1', name: 'old', color: null, updated_at: 1, is_deleted: false },
          { id: 't2', name: 'gone', color: null, updated_at: 1, is_deleted: false },
        ],
      },
      'devB/tags.bin': {
        tags: [
          { id: 't1', name: 'new', color: '#fff', updated_at: 2, is_deleted: false },
          { id: 't2', name: 'gone', color: null, updated_at: 2, is_deleted: true },
        ],
      },
      'devA/templates.bin': {
        templates: [
          {
            id: 'tp',
            name: 'Tpl',
            description: 'd',
            content_b64: 'AQID',
            sort_order: 3,
            created_at: 4,
            updated_at: 1,
            is_deleted: false,
          },
        ],
      },
    })
    const taxonomy = await readTaxonomy(db, core, ring)
    expect(taxonomy.tags).toEqual([{ id: 't1', name: 'new', color: '#fff' }])
    expect(taxonomy.templates).toEqual([
      {
        id: 'tp',
        name: 'Tpl',
        description: 'd',
        content: [1, 2, 3],
        is_predefined: false,
        sort_order: 3,
        created_at: 4,
      },
    ])
  })

  it('lists every tag id (live or deleted) and the deleted template ids', async () => {
    const tpl = (id: string, updated_at: number, is_deleted: boolean): Record<string, unknown> => ({
      id,
      name: id,
      description: null,
      content_b64: null,
      sort_order: 0,
      created_at: 0,
      updated_at,
      is_deleted,
    })
    const { db, core } = build({
      'devA/tags.bin': {
        tags: [
          { id: 't1', name: 'a', color: null, updated_at: 1, is_deleted: false },
          { id: 't2', name: 'b', color: null, updated_at: 1, is_deleted: true },
        ],
      },
      'devA/templates.bin': { templates: [tpl('p1', 1, false), tpl('p2', 2, true)] },
      'devB/templates.bin': { templates: [tpl('p1', 3, true), tpl('p2', 1, false)] },
    })
    const taxonomy = await readTaxonomy(db, core, ring)
    expect([...taxonomy.knownTagIds].sort()).toEqual(['t1', 't2'])
    expect([...taxonomy.deletedTemplateIds].sort()).toEqual(['p1', 'p2'])
    expect(taxonomy.templates).toEqual([])
  })

  it('fails closed when a file cannot be opened', async () => {
    const { db } = build({ 'devA/journals/j1.bin': journalFile('devA', {}) })
    const core = {
      openDeviceBin: () => {
        throw new Error('bad tag')
      },
    } as unknown as Core
    await expect(readTaxonomy(db, core, ring)).rejects.toThrow('bad tag')
  })

  describe('journal lock state is rollback-protected', () => {
    const SEEN = 'journal-seen:j1'
    const seenOf = (store: Map<string, MetaRecord>): unknown => store.get(SEEN)?.value

    it('records the first sight of a locked journal', async () => {
      const { db, core, metaStore } = build({
        'devA/journals/j1.bin': journalFile('devA', { is_locked: true, updated_at: 10 }),
      })
      const taxonomy = await readTaxonomy(db, core, ring)
      expect(taxonomy.excludedJournalIds).toEqual(['j1'])
      expect(seenOf(metaStore)).toBe('10:1:0')
    })

    it('keeps a journal excluded when the cloud copy is rolled back to an older unlocked one', async () => {
      const store = new Map<string, MetaRecord>([[SEEN, { key: SEEN, value: '20:1:0' }]])
      const { db, core } = build(
        { 'devA/journals/j1.bin': journalFile('devA', { updated_at: 10 }) },
        store,
      )
      const taxonomy = await readTaxonomy(db, core, ring)
      expect(taxonomy.excludedJournalIds).toEqual(['j1'])
      expect(taxonomy.journals).toEqual([])
      expect(seenOf(store)).toBe('20:1:0')
    })

    it('keeps a journal excluded when its file was deleted', async () => {
      const store = new Map<string, MetaRecord>([[SEEN, { key: SEEN, value: '20:0:1' }]])
      const { db, core } = build({}, store)
      const taxonomy = await readTaxonomy(db, core, ring)
      expect(taxonomy.excludedJournalIds).toEqual(['j1'])
      expect(taxonomy.knownJournalIds).toEqual(['j1'])
    })

    it('reports an unknown journal id as not known, and a seen unlocked one as known', async () => {
      const store = new Map<string, MetaRecord>([[SEEN, { key: SEEN, value: '5:0:0' }]])
      const { db, core } = build(
        { 'devA/journals/j2.bin': journalFile('devA', { journal_id: 'j2' }) },
        store,
      )
      const taxonomy = await readTaxonomy(db, core, ring)
      expect([...taxonomy.knownJournalIds].sort()).toEqual(['j1', 'j2'])
      expect(taxonomy.excludedJournalIds).toEqual([])
      expect(taxonomy.knownJournalIds).not.toContain('j3')
    })

    it('a legitimate newer unlock re-admits the journal and updates the record', async () => {
      const store = new Map<string, MetaRecord>([[SEEN, { key: SEEN, value: '20:1:0' }]])
      const { db, core } = build(
        { 'devA/journals/j1.bin': journalFile('devA', { updated_at: 30 }) },
        store,
      )
      const taxonomy = await readTaxonomy(db, core, ring)
      expect(taxonomy.excludedJournalIds).toEqual([])
      expect(taxonomy.journals.map((j) => j.id)).toEqual(['j1'])
      expect(seenOf(store)).toBe('30:0:0')
    })

    it('ignores a damaged record and survives ids named like Object.prototype keys', async () => {
      const store = new Map<string, MetaRecord>([
        [SEEN, { key: SEEN, value: 'garbage' }],
        ['journal-seen:__proto__', { key: 'journal-seen:__proto__', value: '9:1:0' }],
      ])
      const { db, core } = build(
        {
          'devA/journals/j1.bin': journalFile('devA', {}),
          'devA/journals/p.bin': journalFile('devA', {
            journal_id: 'constructor',
            auto_tag_ids: ['t1'],
          }),
        },
        store,
      )
      const taxonomy = await readTaxonomy(db, core, ring)
      expect(taxonomy.excludedJournalIds).toEqual(['__proto__'])
      expect(taxonomy.autoTagIds.constructor).toEqual(['t1'])
      expect(Object.getPrototypeOf(taxonomy.autoTagIds)).toBeNull()
    })
  })
})
