import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { Core, OutboxIntentV2 } from '../../core/core'
import type { Template } from '../../../../src/types/template'
import { FakeVault, type FakeSpec } from '../commands/readTestKit'
import { sha256Hex } from '../drafts'
import type { KeyRing } from '../keys'
import { WRAPPED_MASTER_HEX_LEN, openWebDb, type DraftKind, type WebDb } from '../storage/idb'
import {
  createEmptyOutboxFields,
  type FieldChange,
  type OutboxAckEntry,
  type OutboxEntryV1,
} from './outbox'
import {
  UNDECIDED_GRACE_SECS,
  runRetention,
  type RetentionDesktops,
  type RetentionV2,
} from './retention'

const WEB = 'web-1'
const DAY = 86400
const T0 = 1_800_000_000
const enc = new TextEncoder()
const dec = new TextDecoder()
const PATH = (id: string): string => `${WEB}/outbox/${id}.bin`

/** Fake core: "sealed" bytes are the JSON text; a leading `!` fails to open. */
const core = {
  openOutboxEntry: (_r: unknown, b: Uint8Array) => dec.decode(b),
  // A v2 body has a `kind`; anything else is a v1 entry frame.
  openOutboxIntent: (_r: unknown, b: Uint8Array) => {
    const json = dec.decode(b)
    const parsed = JSON.parse(json) as Record<string, unknown>
    return { version: 'kind' in parsed ? 2 : 1, json, free: () => undefined }
  },
  openOutboxAcks: (_r: unknown, b: Uint8Array) => {
    if (b[0] === 0x21) throw new Error('aead: tag mismatch')
    return dec.decode(b)
  },
} as unknown as Core
const ring = {} as KeyRing

const title = (value: string, over: Partial<FieldChange<string>> = {}): FieldChange<string> => ({
  value,
  base: 'Old',
  base_updated_at: 1000,
  change_seq: 7,
  changed_at_secs: T0,
  ...over,
})

function intent(id: string, over: Partial<OutboxEntryV1> = {}): OutboxEntryV1 {
  return {
    schema_version: 1,
    entry_id: id,
    web_device_id: WEB,
    created_on_web: false,
    web_updated_at_secs: T0,
    base_state_vector: [],
    yjs_full_state: [],
    content_text: null,
    preview_text: null,
    fields: { ...createEmptyOutboxFields(), title: title('New') },
    media: [],
    ...over,
  }
}

const sealedOf = (i: OutboxEntryV1): Uint8Array => enc.encode(JSON.stringify(i))

function ack(
  id: string,
  over: Partial<OutboxAckEntry> & {
    decision?: string
    reason?: string | null
    at?: number
    field?: string
  } = {},
): OutboxAckEntry {
  const { decision, reason, at, field, ...rest } = over
  return {
    path: PATH(id),
    content_hash: 'any',
    applied_updated_at: null,
    created: false,
    refused_reason: null,
    decided:
      decision === undefined
        ? []
        : [
            {
              field: field ?? 'title',
              change_seq: 7,
              decision,
              decided_updated_at: at ?? 1100,
              reason: reason ?? null,
            },
          ],
    ...rest,
  }
}

interface Rig {
  db: WebDb
  now: { secs: number }
  desktops: RetentionDesktops
  vault: FakeVault
  draft: (i: OutboxEntryV1, pushed?: boolean) => Promise<Uint8Array>
  acks: (desktop: string, entries: OutboxAckEntry[] | 'corrupt') => Promise<void>
  /** A fresh vault over `specs` (a reload or a newer synced state), hydrated from the drafts. */
  reload: (specs: FakeSpec[]) => Promise<void>
  /** Passed to the pass as `v2` when set. */
  v2?: RetentionV2
  run: () => ReturnType<typeof runRetention>
}

async function rig(specs: FakeSpec[], desktops: string[] = ['desk-a']): Promise<Rig> {
  const db = await openWebDb({ factory: new IDBFactory() })
  await db.device.put({
    deviceId: WEB,
    wrappedMasterHex: 'ab'.repeat(WRAPPED_MASTER_HEX_LEN / 2),
    kekSaltHex: 'cd'.repeat(16),
    recoveryGeneration: 0,
    masterFingerprint: 'fp',
    name: 'Memlore Web',
  })
  const now = { secs: T0 }
  const d: RetentionDesktops = {
    manifests: desktops,
    slots: new Set([WEB, ...desktops]),
    tombstones: new Set(),
  }
  const r: Rig = {
    db,
    now,
    desktops: d,
    vault: new FakeVault(specs),
    draft: async (i, pushed = true) => {
      const sealed = sealedOf(i)
      await db.drafts.put({
        entryId: i.entry_id,
        sealed,
        updatedAt: 1,
        ...(pushed ? { pushedHash: await sha256Hex(sealed) } : {}),
      })
      r.vault.setOutboxIntents([
        ...r.vault.getOutboxIntents().filter((x) => x.entry_id !== i.entry_id),
        i,
      ])
      return sealed
    },
    acks: async (desktop, entries) => {
      const bytes =
        entries === 'corrupt'
          ? enc.encode('!')
          : enc.encode(
              JSON.stringify({ schema_version: 1, desktop_device_id: desktop, acks: entries }),
            )
      await db.files.put({
        path: `${desktop}/outbox-acks.bin`,
        ciphertext: bytes,
        etag: null,
        modifiedTime: null,
        lastAccess: 0,
        pinned: false,
      })
    },
    reload: async (next) => {
      r.vault = new FakeVault(next)
      const drafts = await db.drafts.list()
      r.vault.setOutboxIntents(drafts.map((x) => JSON.parse(dec.decode(x.sealed)) as OutboxEntryV1))
    },
    run: () =>
      runRetention({
        db,
        core,
        ring,
        nowSecs: () => now.secs,
        desktops: d,
        vault: r.vault,
        ...(r.v2 === undefined ? {} : { v2: r.v2 }),
      }),
  }
  return r
}

/** A synced Yjs doc, and an intent state it contains (the web edit already merged). */
function docs(): { synced: number[]; edit: number[]; unmerged: number[] } {
  const doc = new Y.Doc()
  doc.getText('t').insert(0, 'web ')
  const edit = Array.from(Y.encodeStateAsUpdate(doc))
  doc.getText('t').insert(4, 'desktop')
  const synced = Array.from(Y.encodeStateAsUpdate(doc))
  const other = new Y.Doc()
  other.getText('t').insert(0, 'not merged')
  return { synced, edit, unmerged: Array.from(Y.encodeStateAsUpdate(other)) }
}

const blobsOf = async (db: WebDb): Promise<string[]> =>
  (await db.blobs.sizes()).map((b) => b.path).sort()

async function putBlob(db: WebDb, path: string): Promise<void> {
  await db.blobs.put({ path, bytes: new Uint8Array([1]), size: 1, lastAccess: 0 })
}

describe('intent retention', () => {
  let r: Rig
  const { synced, edit, unmerged } = docs()

  describe('reflected in synced state', () => {
    const media = { media_id: 'm0', file_name: 'a.jpg', file_type: 'image/jpeg', size: 1 }
    const reflected = intent('e1', {
      yjs_full_state: edit,
      media: [{ ...media, has_thumb: true }],
    })

    beforeEach(async () => {
      r = await rig([{ id: 'e1', updatedAt: 1200, title: 'New', media: 1, yjs: synced }])
      for (const p of ['outbox/m-m0', 'outbox/m-m0.thumb', 'outbox/m-other', 'cache-x']) {
        await putBlob(r.db, p)
      }
    })

    it('drops a pushed draft, its outbox media and its overlay intent, silently', async () => {
      await r.draft(reflected)
      const res = await r.run()
      expect(res).toEqual({ dropped: ['e1'], notices: [], changed: true })
      expect(await r.db.drafts.get('e1')).toBeUndefined()
      expect(await blobsOf(r.db)).toEqual(['cache-x', 'outbox/m-other'])
      expect(r.vault.getOutboxIntent('e1')).toBeUndefined()
    })

    it('keeps the outbox media another stored draft still references', async () => {
      await r.draft(reflected)
      await r.draft(intent('e2', { media: [{ ...media, has_thumb: true }] }), false)
      expect((await r.run()).dropped).toEqual(['e1'])
      expect(await r.db.drafts.get('e1')).toBeUndefined()
      expect(await blobsOf(r.db)).toEqual([
        'cache-x',
        'outbox/m-m0',
        'outbox/m-m0.thumb',
        'outbox/m-other',
      ])
    })

    it('never drops an unpushed draft', async () => {
      await r.draft(reflected, false)
      const res = await r.run()
      expect(res.dropped).toEqual([])
      expect(await r.db.drafts.get('e1')).toBeDefined()
      expect(await blobsOf(r.db)).toContain('outbox/m-m0')
    })

    it('keeps it while the synced Yjs doc lacks the web edit', async () => {
      await r.draft({ ...reflected, yjs_full_state: unmerged })
      expect((await r.run()).dropped).toEqual([])
    })

    it('keeps it while a media id is missing from the synced metadata', async () => {
      await r.reload([{ id: 'e1', updatedAt: 1200, title: 'New', media: 0, yjs: synced }])
      await r.draft(reflected)
      expect((await r.run()).dropped).toEqual([])
    })
  })

  it.each([
    ['tombstoned', { tombstone: true }],
    ['locked', { locked: true }],
    ['invisible', { invisible: true }],
  ])('drops a pushed draft whose entry is %s', async (_name, flags) => {
    r = await rig([{ id: 'e1', updatedAt: 1200, ...flags }])
    if ('tombstone' in flags) r.desktops.tombstones = new Set(['e1'])
    await r.draft(intent('e1', { yjs_full_state: unmerged }))
    expect(await r.run()).toMatchObject({ dropped: ['e1'], notices: [] })
  })

  it('drops when every field is resolved and shows the refusal once', async () => {
    r = await rig([{ id: 'e1', updatedAt: 1000, title: 'Old', text: 'x' }])
    await r.draft(intent('e1'))
    await r.acks('desk-a', [ack('e1', { decision: 'refused', reason: 'journal' })])
    const res = await r.run()
    expect(res.dropped).toEqual(['e1'])
    expect(res.notices).toEqual([
      { kind: 'refused', field: 'title', title: 'Old', reason: 'journal' },
    ])
  })

  it('skips a malformed ack entry instead of failing the pass', async () => {
    r = await rig([{ id: 'e1', updatedAt: 1000, title: 'Old', text: 'x' }])
    await r.draft(intent('e1'))
    const garbage = [null, 42, { path: PATH('e1') }] as unknown as OutboxAckEntry[]
    await r.acks('desk-a', [...garbage, ack('e1', { decision: 'refused', reason: 'journal' })])
    const res = await r.run()
    expect(res.dropped).toEqual(['e1'])
    expect(res.notices).toEqual([
      { kind: 'refused', field: 'title', title: 'Old', reason: 'journal' },
    ])
  })

  it('drops a created-on-web draft every desktop refused to create, with a notice', async () => {
    r = await rig([], ['desk-a', 'desk-b'])
    const i = intent('e9', { created_on_web: true })
    const hash = await sha256Hex(sealedOf(i))
    await r.draft(i)
    const refused = ack('e9', { content_hash: hash, refused_reason: 'no_journal' })
    await r.acks('desk-a', [refused])
    expect((await r.run()).dropped).toEqual([])
    await r.acks('desk-b', [refused])
    expect(await r.run()).toEqual({
      dropped: ['e9'],
      notices: [{ kind: 'refused', title: 'New', reason: 'no_journal' }],
      changed: true,
    })
  })

  it('two desktops: A applied but not pushed, B refused first: no drop, no notice; silent after A pushes', async () => {
    r = await rig([{ id: 'e1', updatedAt: 1000, title: 'Old' }], ['desk-a', 'desk-b'])
    await r.draft(intent('e1'))
    await r.acks('desk-b', [ack('e1', { decision: 'refused', reason: null, at: 1500 })])
    await r.acks('desk-a', [ack('e1', { decision: 'applied', at: 2000 })])
    expect(await r.run()).toEqual({ dropped: [], notices: [], changed: false })
    expect(r.vault.getOutboxIntent('e1')?.fields.title?.value).toBe('New')

    await r.reload([{ id: 'e1', updatedAt: 2000, title: 'New' }])
    expect(await r.run()).toEqual({ dropped: ['e1'], notices: [], changed: true })
  })

  it('a deterministic refusal is final only once every importer-capable desktop decided', async () => {
    r = await rig([{ id: 'e1', updatedAt: 1000, title: 'Old' }], ['desk-a', 'desk-b'])
    await r.draft(intent('e1'))
    await r.acks('desk-a', [ack('e1', { decision: 'refused', reason: 'journal' })])
    await r.acks('desk-b', [])
    expect((await r.run()).dropped).toEqual([])
    await r.acks('desk-b', [ack('e1', { decision: 'refused', reason: 'journal' })])
    expect((await r.run()).dropped).toEqual(['e1'])
  })

  it('a desktop without a slot is not importer-capable', async () => {
    r = await rig([{ id: 'e1', updatedAt: 1000, title: 'Old' }], ['desk-a', 'desk-b'])
    r.desktops.slots = new Set([WEB, 'desk-a'])
    await r.draft(intent('e1'))
    await r.acks('desk-a', [ack('e1', { decision: 'refused', reason: 'journal' })])
    await r.acks('desk-b', [])
    expect((await r.run()).dropped).toEqual(['e1'])
  })

  it('a conflict refusal resolves after 30 days on the web clock while a desktop stays silent', async () => {
    r = await rig([{ id: 'e1', updatedAt: 1000, title: 'Old' }], ['desk-a', 'desk-b'])
    await r.draft(intent('e1'))
    await r.acks('desk-a', [ack('e1', { decision: 'refused', reason: null })])
    await r.acks('desk-b', [])
    expect((await r.run()).dropped).toEqual([])
    r.now.secs = T0 + 30 * DAY - 1
    expect((await r.run()).dropped).toEqual([])
    r.now.secs = T0 + 30 * DAY
    expect(await r.run()).toEqual({
      dropped: ['e1'],
      notices: [{ kind: 'replaced', field: 'title', title: 'Old' }],
      changed: true,
    })
  })

  it('a desktop with a slot but no acks file is undecided for 7 days after the push', async () => {
    r = await rig([{ id: 'e1', updatedAt: 1000, title: 'Old' }], ['desk-a', 'desk-b'])
    await r.draft(intent('e1'))
    await r.acks('desk-a', [ack('e1', { decision: 'refused', reason: 'journal' })])
    expect((await r.run()).dropped).toEqual([])
    r.now.secs = T0 + UNDECIDED_GRACE_SECS - 1
    expect((await r.run()).dropped).toEqual([])
    r.now.secs = T0 + UNDECIDED_GRACE_SECS
    expect((await r.run()).dropped).toEqual(['e1'])
  })

  describe('a re-onboard (clearPushed) racing a pass', () => {
    const setup = async (): Promise<void> => {
      r = await rig([{ id: 'e1', updatedAt: 1000, title: 'Old' }], ['desk-a', 'desk-b'])
      await r.draft(intent('e1'))
      await r.acks('desk-a', [ack('e1', { decision: 'refused', reason: 'journal' })])
    }
    /** A pass whose draft list was read just before `clearPushed` committed. */
    const racingRun = () =>
      runRetention({
        db: {
          files: r.db.files,
          meta: r.db.meta,
          device: r.db.device,
          drafts: {
            ...r.db.drafts,
            list: async () => {
              const drafts = await r.db.drafts.list()
              await r.db.drafts.clearPushed()
              return drafts
            },
          },
        },
        core,
        ring,
        nowSecs: () => r.now.secs,
        desktops: r.desktops,
        vault: r.vault,
      })

    it('writes no first-pushed time back and keeps the draft, silently', async () => {
      await setup()
      expect(await racingRun()).toEqual({ dropped: [], notices: [], changed: false })
      expect(await r.db.meta.get('outbox-pushed-at:e1')).toBeUndefined()
      expect(await r.db.drafts.get('e1')).toBeDefined()
    })

    it('restarts the undecided grace from the re-push', async () => {
      await setup()
      await racingRun()
      r.now.secs = T0 + UNDECIDED_GRACE_SECS + DAY
      const draft = await r.db.drafts.get('e1')
      if (draft === undefined) throw new Error('draft missing')
      await r.db.drafts.markPushed('e1', draft.sealed, await sha256Hex(draft.sealed))
      expect((await r.run()).dropped).toEqual([])
      r.now.secs += UNDECIDED_GRACE_SECS
      expect((await r.run()).dropped).toEqual(['e1'])
    })
  })

  describe('resolved fields', () => {
    const pending = (): OutboxEntryV1 =>
      intent('e1', {
        fields: {
          ...createEmptyOutboxFields(),
          title: title('New'),
          emotion: {
            value: 'good',
            base: null,
            base_updated_at: 1000,
            change_seq: 8,
            changed_at_secs: T0,
          },
        },
      })

    beforeEach(async () => {
      // A desktop applied the title, then a later desktop edit replaced it; emotion still pending.
      r = await rig([{ id: 'e1', updatedAt: 3000, title: 'Desk' }])
      await r.acks('desk-a', [ack('e1', { decision: 'applied', at: 2000 })])
    })

    it('leave the overlay immediately and the stored draft only at the next rewrite', async () => {
      const sealed = await r.draft(pending())
      const res = await r.run()
      expect(res).toEqual({
        dropped: [],
        notices: [{ kind: 'replaced', field: 'title', title: 'Desk' }],
        changed: true,
      })
      const overlay = r.vault.getOutboxIntent('e1')
      expect(overlay?.fields.title).toBeNull()
      expect(overlay?.fields.emotion?.value).toBe('good')
      expect((await r.db.drafts.get('e1'))?.sealed).toEqual(sealed)
    })

    it('notices are not repeated after a reload', async () => {
      await r.draft(pending())
      expect((await r.run()).notices).toHaveLength(1)
      await r.reload([{ id: 'e1', updatedAt: 3000, title: 'Desk' }])
      const again = await r.run()
      expect(again.notices).toEqual([])
      expect(r.vault.getOutboxIntent('e1')?.fields.title).toBeNull()
    })

    it('never overwrite a newer intent a write set meanwhile', async () => {
      await r.draft(pending())
      const newer = { ...pending(), web_updated_at_secs: T0 + 5 }
      r.vault.setOutboxIntents([newer])
      await r.run()
      expect(r.vault.getOutboxIntent('e1')).toBe(newer)
    })
  })

  describe('read errors keep everything', () => {
    beforeEach(async () => {
      r = await rig(
        [{ id: 'e1', updatedAt: 1200, title: 'New', yjs: synced }],
        ['desk-a', 'desk-b'],
      )
      await r.draft(intent('e1', { yjs_full_state: edit }))
    })

    it('an acks file that cannot be opened', async () => {
      await r.acks('desk-b', 'corrupt')
      expect(await r.run()).toEqual({ dropped: [], notices: [], changed: false })
      expect(await r.db.drafts.get('e1')).toBeDefined()
    })

    it('an unknown slot list', async () => {
      r.desktops.slots = null
      expect((await r.run()).dropped).toEqual([])
    })

    it('a synced payload that cannot be read', async () => {
      await r.reload([{ id: 'e1', updatedAt: 1200, fails: true }])
      expect((await r.run()).dropped).toEqual([])
    })
  })
})

describe('outbox v2 retention (Phase 21)', () => {
  const ID = '11111111-1111-4111-8111-111111111111'
  const base = { web_device_id: WEB, web_updated_at_secs: T0 }
  const tagIntent: OutboxIntentV2 = {
    ...base,
    kind: 'create_tag',
    tag_id: ID,
    name: 'Work',
    color: null,
  }
  const journalIntent: OutboxIntentV2 = {
    ...base,
    kind: 'create_journal',
    journal_id: ID,
    name: 'Trips',
    color: null,
    auto_tag_ids: [],
  }
  const upsert: OutboxIntentV2 = {
    ...base,
    kind: 'upsert_template',
    template_id: ID,
    name: 'Daily',
    description: null,
    content_b64: btoa('abc'),
    sort_order: 2,
    base_updated_at: 1000,
  }
  const deleteTpl: OutboxIntentV2 = {
    ...base,
    kind: 'delete_template',
    template_id: ID,
    base_updated_at: 1000,
  }
  const trash: OutboxIntentV2 = {
    ...base,
    kind: 'trash_entry',
    entry_id: ID,
    base_updated_at: 1000,
  }
  const KIND: Record<OutboxIntentV2['kind'], [Exclude<DraftKind, 'entry'>, string]> = {
    create_journal: ['journal', 'j'],
    create_tag: ['tag', 't'],
    upsert_template: ['template', 'p'],
    delete_template: ['template', 'p'],
    trash_entry: ['trash', 'd'],
  }
  const keyOf = (i: OutboxIntentV2): string => `${KIND[i.kind][1]}-${ID}`
  const v2Path = (i: OutboxIntentV2): string => `${WEB}/outbox/${keyOf(i)}.bin`
  const template = (over: Partial<Template> = {}): Template => ({
    id: ID,
    name: 'Daily',
    description: null,
    content: Array.from(enc.encode('abc')),
    is_predefined: false,
    sort_order: 2,
    created_at: 1,
    ...over,
  })

  type V2Case = [string, OutboxIntentV2, Partial<RetentionV2['taxonomy']>]

  let r: Rig

  function v2State(over: Partial<RetentionV2['taxonomy']> = {}, capable = ['desk-a']): RetentionV2 {
    return {
      desktops: new Set(capable),
      taxonomy: {
        knownJournalIds: [],
        knownTagIds: [],
        templates: [],
        deletedTemplateIds: [],
        ...over,
      },
    }
  }

  async function v2Draft(i: OutboxIntentV2, pushed = true): Promise<string> {
    const sealed = enc.encode(JSON.stringify(i))
    const hash = await sha256Hex(sealed)
    await r.db.drafts.put({
      entryId: keyOf(i),
      kind: KIND[i.kind][0],
      sealed,
      updatedAt: 1,
      ...(pushed ? { pushedHash: hash } : {}),
    })
    return hash
  }

  const v2Ack = (i: OutboxIntentV2, over: Partial<OutboxAckEntry>): OutboxAckEntry => ({
    path: v2Path(i),
    content_hash: 'any',
    applied_updated_at: null,
    decided: [],
    created: false,
    refused_reason: null,
    ...over,
  })

  beforeEach(async () => {
    r = await rig([], ['desk-a', 'desk-old'])
    r.v2 = v2State()
  })

  describe('acks (21.1)', () => {
    it('drops a pushed create acked `created` by a capable desktop, silently', async () => {
      await v2Draft(tagIntent)
      await r.acks('desk-a', [v2Ack(tagIntent, { created: true })])
      expect(await r.run()).toEqual({ dropped: [keyOf(tagIntent)], notices: [], changed: true })
      expect(await r.db.drafts.get(keyOf(tagIntent))).toBeUndefined()
    })

    it('ignores the null ack of a v0.2.2 desktop (not advertising v2)', async () => {
      const hash = await v2Draft(tagIntent)
      await r.acks('desk-old', [v2Ack(tagIntent, { content_hash: hash })])
      expect(await r.run()).toEqual({ dropped: [], notices: [], changed: false })
      // Not even a refusal from it counts.
      await r.acks('desk-old', [v2Ack(tagIntent, { content_hash: hash, refused_reason: 'x' })])
      expect((await r.run()).dropped).toEqual([])
      expect(await r.db.drafts.get(keyOf(tagIntent))).toBeDefined()
    })

    it('a refusal from the capable desktop is final: dropped with a notice', async () => {
      const hash = await v2Draft(tagIntent)
      await r.acks('desk-a', [
        v2Ack(tagIntent, { content_hash: hash, refused_reason: 'name_taken' }),
      ])
      expect(await r.run()).toEqual({
        dropped: [keyOf(tagIntent)],
        notices: [{ kind: 'refused', field: 'create_tag', title: 'Work', reason: 'name_taken' }],
        changed: true,
      })
    })

    it('applied by one capable desktop beats a refusal by another', async () => {
      r.v2 = v2State({}, ['desk-a', 'desk-old'])
      const hash = await v2Draft(upsert)
      await r.acks('desk-old', [
        v2Ack(upsert, { content_hash: hash, refused_reason: 'changed_on_desktop' }),
      ])
      expect((await r.run()).dropped).toEqual([]) // desk-a undecided
      await r.acks('desk-a', [v2Ack(upsert, { content_hash: hash, applied_updated_at: 1500 })])
      expect(await r.run()).toEqual({ dropped: [keyOf(upsert)], notices: [], changed: true })
    })

    it('keeps a draft re-saved after a refusal of its pushed revision', async () => {
      const oldSealed = enc.encode(JSON.stringify(tagIntent))
      const oldHash = await sha256Hex(oldSealed)
      await r.db.drafts.put({
        entryId: keyOf(tagIntent),
        kind: 'tag',
        sealed: enc.encode(JSON.stringify({ ...tagIntent, name: 'Work 2' })),
        updatedAt: 2,
        pushedHash: oldHash,
      })
      await r.acks('desk-a', [
        v2Ack(tagIntent, { content_hash: oldHash, refused_reason: 'name_taken' }),
      ])
      expect(await r.run()).toEqual({ dropped: [], notices: [], changed: false })
      expect(await r.db.drafts.get(keyOf(tagIntent))).toBeDefined()
    })

    it('a capable desktop with no acks file stops counting after the 7-day grace', async () => {
      r.v2 = v2State({}, ['desk-a', 'desk-old'])
      const hash = await v2Draft(tagIntent)
      await r.acks('desk-a', [
        v2Ack(tagIntent, { content_hash: hash, refused_reason: 'name_taken' }),
      ])
      expect((await r.run()).dropped).toEqual([]) // desk-old undecided
      r.now.secs = T0 + UNDECIDED_GRACE_SECS - 1
      expect((await r.run()).dropped).toEqual([])
      r.now.secs = T0 + UNDECIDED_GRACE_SECS
      expect(await r.run()).toEqual({
        dropped: [keyOf(tagIntent)],
        notices: [{ kind: 'refused', field: 'create_tag', title: 'Work', reason: 'name_taken' }],
        changed: true,
      })
    })

    it('an apply of an older revision keeps the newer one', async () => {
      await v2Draft(upsert)
      await r.acks('desk-a', [v2Ack(upsert, { content_hash: 'older', applied_updated_at: 1500 })])
      expect((await r.run()).dropped).toEqual([])
    })
  })

  describe('reflected in the synced state (21.2)', () => {
    it.each([
      ['a journal in `journals/`', journalIntent, { knownJournalIds: [ID] }],
      ['a live tag in `tags.bin`', tagIntent, { knownTagIds: [ID] }],
      ['a tag reflected then deleted on desktop', tagIntent, { knownTagIds: [ID] }],
      ['a template with the same content', upsert, { templates: [template()] }],
      ['a deleted template', deleteTpl, { deletedTemplateIds: [ID] }],
    ] satisfies V2Case[])('drops %s, silently', async (_name, i, taxonomy) => {
      r.v2 = v2State(taxonomy)
      await v2Draft(i)
      expect(await r.run()).toEqual({ dropped: [keyOf(i)], notices: [], changed: true })
    })

    it('keeps an upsert of a template deleted on desktop until the refusal ack', async () => {
      r.v2 = v2State({ deletedTemplateIds: [ID] })
      const hash = await v2Draft(upsert)
      expect(await r.run()).toEqual({ dropped: [], notices: [], changed: false })
      await r.acks('desk-a', [
        v2Ack(upsert, { content_hash: hash, refused_reason: 'changed_on_desktop' }),
      ])
      expect(await r.run()).toEqual({
        dropped: [keyOf(upsert)],
        notices: [
          {
            kind: 'refused',
            field: 'upsert_template',
            title: 'Daily',
            reason: 'changed_on_desktop',
          },
        ],
        changed: true,
      })
    })

    it('drops a trash whose entry is trashed (or tombstoned) in the manifests', async () => {
      r.desktops.tombstones = new Set([ID])
      await v2Draft(trash)
      expect((await r.run()).dropped).toEqual([keyOf(trash)])
    })

    it.each([
      ['a template whose content differs', upsert, { templates: [template({ name: 'Other' })] }],
      ['a delete while the template is live', deleteTpl, { templates: [template()] }],
      ['an unknown journal', journalIntent, { knownTagIds: [ID] }],
    ] satisfies V2Case[])('keeps %s', async (_name, i, taxonomy) => {
      r.v2 = v2State(taxonomy)
      await v2Draft(i)
      expect((await r.run()).dropped).toEqual([])
    })

    it('never drops an unpushed v2 draft', async () => {
      r.v2 = v2State({ knownTagIds: [ID] })
      await v2Draft(tagIntent, false)
      await r.acks('desk-a', [v2Ack(tagIntent, { created: true })])
      expect((await r.run()).dropped).toEqual([])
      expect(await r.db.drafts.get(keyOf(tagIntent))).toBeDefined()
    })

    it('without the v2 state, keeps every v2 draft and says nothing', async () => {
      r.v2 = undefined
      await v2Draft(tagIntent)
      await r.acks('desk-a', [v2Ack(tagIntent, { created: true })])
      expect(await r.run()).toEqual({ dropped: [], notices: [], changed: false })
    })

    it('never loads a v2 draft key as an entry', async () => {
      await v2Draft(tagIntent)
      await r.run()
      expect(r.vault.loadCalls.flat()).not.toContain(keyOf(tagIntent))
    })
  })

  describe('waiting for a newer desktop (21.2)', () => {
    it('fires once per draft only while no slot-holding desktop advertises v2; kept', async () => {
      r.v2 = v2State({}, [])
      await v2Draft(tagIntent)
      expect(await r.run()).toEqual({
        dropped: [],
        notices: [{ kind: 'waiting_newer_desktop', title: 'Work' }],
        changed: false,
      })
      expect((await r.run()).notices).toEqual([])
      expect(await r.db.drafts.get(keyOf(tagIntent))).toBeDefined()
    })

    it('fires for an unpushed draft too', async () => {
      r.v2 = v2State({}, [])
      await v2Draft(trash, false)
      expect((await r.run()).notices).toEqual([{ kind: 'waiting_newer_desktop' }])
    })

    it('does not fire while a capable desktop exists', async () => {
      await v2Draft(tagIntent)
      expect((await r.run()).notices).toEqual([])
    })

    it('a capable desktop that is not slot-holding does not count', async () => {
      r.v2 = v2State({}, ['desk-gone'])
      await v2Draft(tagIntent)
      expect((await r.run()).notices).toEqual([{ kind: 'waiting_newer_desktop', title: 'Work' }])
    })
  })
})
