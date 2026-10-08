import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  type FieldChange,
  type OutboxAcksV1,
  type OutboxEntryV1,
  buildOutboxIntent,
  createEmptyOutboxFields,
  isIntentPathValid,
  packOutboxUploadIntents,
  resolveField,
  shouldRetainIntent,
  type RetainParams,
} from './outbox'
import type { EntryMetadata } from '../vault'

const INTENT_PATH = 'web-1/outbox/entry-1.bin'

describe('outbox field resolution', () => {
  const baseEntry: EntryMetadata = {
    entry_id: 'entry-1',
    device_id: 'desktop-a',
    updated_at: 1000,
    entry_date: 1000,
    created_at: 1000,
    journal_id: 'journal-1',
    journal_name: null,
    title: 'Original Title',
    preview_text: '',
    content_text: '',
    emotion: null,
    is_favorite: false,
    is_deleted: false,
    is_locked: false,
    is_invisible: false,
    vault_id: null,
    tag_ids: ['tag-1'],
  }

  const titleChange: FieldChange<string> = {
    value: 'Web Title',
    base: 'Original Title',
    base_updated_at: 1000,
    change_seq: 42,
    changed_at_secs: 1005,
  }

  it('drops field silently when synced state reflects it (L == value)', () => {
    const synced: EntryMetadata = { ...baseEntry, title: 'Web Title', updated_at: 1010 }
    const res = resolveField({
      fieldName: 'title',
      change: titleChange,
      syncedEntry: synced,
      allAcks: [],
      intentPath: INTENT_PATH,
      capableDesktops: ['desktop-a', 'desktop-b'],
      nowSecs: 1020,
      entryTitleOrId: 'Web Title',
    })
    expect(res.resolved).toBe(true)
    expect(res.notice).toBeUndefined()
  })

  it('two-desktop ordering (round 14): applied wins over refused while in flight', () => {
    // Desktop A applied rev with decided_updated_at = 2000
    // Desktop B has no provenance and refused with conflict
    const acksA: OutboxAcksV1 = {
      schema_version: 1,
      desktop_device_id: 'desktop-a',
      acks: [
        {
          path: INTENT_PATH,
          content_hash: 'hash1',
          applied_updated_at: 2000,
          created: false,
          refused_reason: null,
          decided: [
            {
              field: 'title',
              change_seq: 42,
              decision: 'applied',
              decided_updated_at: 2000,
              reason: null,
            },
          ],
        },
      ],
    }

    const acksB: OutboxAcksV1 = {
      schema_version: 1,
      desktop_device_id: 'desktop-b',
      acks: [
        {
          path: INTENT_PATH,
          content_hash: 'hash1',
          applied_updated_at: null,
          created: false,
          refused_reason: null,
          decided: [
            {
              field: 'title',
              change_seq: 42,
              decision: 'refused',
              decided_updated_at: 1500,
              reason: 'conflict',
            },
          ],
        },
      ],
    }

    // Synced entry still reflects base state (Desktop A has not pushed its sync files yet)
    const syncedBeforePush: EntryMetadata = { ...baseEntry, updated_at: 1000 }
    const resPending = resolveField({
      fieldName: 'title',
      change: titleChange,
      syncedEntry: syncedBeforePush,
      allAcks: [acksA, acksB],
      intentPath: INTENT_PATH,
      capableDesktops: ['desktop-a', 'desktop-b'],
      nowSecs: 1600,
      entryTitleOrId: 'Original Title',
    })

    // Field is NOT dropped and NO notice is shown
    expect(resPending.resolved).toBe(false)
    expect(resPending.notice).toBeUndefined()

    // Once Desktop A pushes, synced value equals 'Web Title'
    const syncedAfterPush: EntryMetadata = { ...baseEntry, title: 'Web Title', updated_at: 2000 }
    const resLanded = resolveField({
      fieldName: 'title',
      change: titleChange,
      syncedEntry: syncedAfterPush,
      allAcks: [acksA, acksB],
      intentPath: INTENT_PATH,
      capableDesktops: ['desktop-a', 'desktop-b'],
      nowSecs: 2050,
      entryTitleOrId: 'Web Title',
    })
    expect(resLanded.resolved).toBe(true)
    expect(resLanded.notice).toBeUndefined()
  })

  it('two-desktop ordering: superseded desktop edit shows replaced notice', () => {
    // Desktop A applied rev with U = 2000, but later desktop edit bumped updated_at >= U with different value
    const acksA: OutboxAcksV1 = {
      schema_version: 1,
      desktop_device_id: 'desktop-a',
      acks: [
        {
          path: INTENT_PATH,
          content_hash: 'hash1',
          applied_updated_at: 2000,
          created: false,
          refused_reason: null,
          decided: [
            {
              field: 'title',
              change_seq: 42,
              decision: 'applied',
              decided_updated_at: 2000,
              reason: null,
            },
          ],
        },
      ],
    }

    const supersededSynced: EntryMetadata = {
      ...baseEntry,
      title: 'Desktop Later Title',
      updated_at: 2500, // >= U
    }

    const res = resolveField({
      fieldName: 'title',
      change: titleChange,
      syncedEntry: supersededSynced,
      allAcks: [acksA],
      intentPath: INTENT_PATH,
      capableDesktops: ['desktop-a'],
      nowSecs: 2600,
      entryTitleOrId: 'Original Title',
    })

    expect(res.resolved).toBe(true)
    expect(res.notice).toEqual({
      kind: 'replaced',
      field: 'title',
      title: 'Original Title',
      change_seq: 42,
    })
  })

  it('deterministic refusal is final when every capable desktop decides', () => {
    const acksA: OutboxAcksV1 = {
      schema_version: 1,
      desktop_device_id: 'desktop-a',
      acks: [
        {
          path: INTENT_PATH,
          content_hash: 'hash1',
          applied_updated_at: null,
          created: false,
          refused_reason: null,
          decided: [
            {
              field: 'journal_id',
              change_seq: 42,
              decision: 'refused',
              decided_updated_at: 1100,
              reason: 'journal',
            },
          ],
        },
      ],
    }

    const journalChange: FieldChange<string> = {
      value: 'locked-journal',
      base: 'journal-1',
      base_updated_at: 1000,
      change_seq: 42,
      changed_at_secs: 1050,
    }

    const res = resolveField({
      fieldName: 'journal_id',
      change: journalChange,
      syncedEntry: baseEntry,
      allAcks: [acksA],
      intentPath: INTENT_PATH,
      capableDesktops: ['desktop-a'],
      nowSecs: 1200,
      entryTitleOrId: 'Original Title',
    })

    expect(res.resolved).toBe(true)
    expect(res.notice).toEqual({
      kind: 'refused',
      field: 'journal_id',
      title: 'Original Title',
      reason: 'journal',
      change_seq: 42,
    })
  })

  it('conflict refusal: waits for all desktops or 30 days', () => {
    const acksB: OutboxAcksV1 = {
      schema_version: 1,
      desktop_device_id: 'desktop-b',
      acks: [
        {
          path: INTENT_PATH,
          content_hash: 'hash1',
          applied_updated_at: null,
          created: false,
          refused_reason: null,
          decided: [
            {
              field: 'title',
              change_seq: 42,
              decision: 'refused',
              decided_updated_at: 1100,
              reason: 'conflict',
            },
          ],
        },
      ],
    }

    // Desktop A has not decided yet
    const pending = resolveField({
      fieldName: 'title',
      change: titleChange,
      syncedEntry: baseEntry,
      allAcks: [acksB],
      intentPath: INTENT_PATH,
      capableDesktops: ['desktop-a', 'desktop-b'],
      firstRefusalTimes: new Map([['title@42', 1100]]),
      nowSecs: 1100 + 100,
      entryTitleOrId: 'Original Title',
    })
    expect(pending.resolved).toBe(false)

    // After 30 days (30 * 86400 = 2,592,000s) on web clock, bounds retention and resolves
    const expired = resolveField({
      fieldName: 'title',
      change: titleChange,
      syncedEntry: baseEntry,
      allAcks: [acksB],
      intentPath: INTENT_PATH,
      capableDesktops: ['desktop-a', 'desktop-b'],
      firstRefusalTimes: new Map([['title@42', 1100]]),
      nowSecs: 1100 + 30 * 86400 + 1,
      entryTitleOrId: 'Original Title',
    })
    expect(expired.resolved).toBe(true)
    expect(expired.notice?.kind).toBe('replaced')
  })
})

describe('outbox intent builder', () => {
  it('creates entry with empty base_state_vector and created_on_web=true for new entry', () => {
    const initialDoc = new Y.Doc()
    initialDoc.getText('content').insert(0, 'New content')
    const initialBytes = Y.encodeStateAsUpdate(initialDoc)

    const intent = buildOutboxIntent({
      entryId: 'entry-new-1',
      webDeviceId: 'web-1',
      createdOnWeb: true,
      baseSyncedDocBytes: null,
      priorIntent: null,
      localDocBytes: initialBytes,
      contentText: 'New content',
      previewText: 'New preview',
      newFields: {
        title: {
          value: 'New Title',
          base: '',
          base_updated_at: 0,
          change_seq: 1,
          changed_at_secs: 1700000000,
        },
      },
      nowSecs: 1700000000,
    })

    expect(intent.created_on_web).toBe(true)
    expect(intent.base_state_vector).toEqual([])
    expect(intent.web_updated_at_secs).toBe(1700000000)
    expect(intent.fields.title?.value).toBe('New Title')
  })

  it('for existing entry, extracts base_state_vector and preserves concurrent desktop text via Yjs', () => {
    const baseDoc = new Y.Doc()
    baseDoc.getText('content').insert(0, 'Hello')
    const baseBytes = Y.encodeStateAsUpdate(baseDoc)

    // Local edit adds ' from web'
    const localDoc = new Y.Doc()
    Y.applyUpdate(localDoc, baseBytes)
    localDoc.getText('content').insert(5, ' from web')
    const localBytes = Y.encodeStateAsUpdate(localDoc)

    const intent = buildOutboxIntent({
      entryId: 'entry-exist-1',
      webDeviceId: 'web-1',
      createdOnWeb: false,
      baseSyncedDocBytes: baseBytes,
      priorIntent: null,
      localDocBytes: localBytes,
      contentText: 'Hello from web',
      previewText: 'Hello from web',
      newFields: {},
      nowSecs: 1700000010,
    })

    expect(intent.created_on_web).toBe(false)
    expect(intent.base_state_vector.length).toBeGreaterThan(0)

    // Verify Yjs merge preserves concurrent desktop edit
    const desktopDoc = new Y.Doc()
    Y.applyUpdate(desktopDoc, baseBytes)
    desktopDoc.getText('content').insert(5, ' from desktop')

    // Desktop applies intent's yjs_full_state
    Y.applyUpdate(desktopDoc, new Uint8Array(intent.yjs_full_state))
    const mergedText = desktopDoc.getText('content').toString()
    expect(mergedText).toContain('from web')
    expect(mergedText).toContain('from desktop')
  })

  it('accumulates fields across multiple edits and rewrites lazily', () => {
    const baseDoc = new Y.Doc()
    const baseBytes = Y.encodeStateAsUpdate(baseDoc)

    // Edit 1: set title
    const intent1 = buildOutboxIntent({
      entryId: 'entry-exist-1',
      webDeviceId: 'web-1',
      createdOnWeb: false,
      baseSyncedDocBytes: baseBytes,
      priorIntent: null,
      localDocBytes: baseBytes,
      contentText: '',
      previewText: '',
      newFields: {
        title: {
          value: 'Title 1',
          base: 'Old Title',
          base_updated_at: 1000,
          change_seq: 1,
          changed_at_secs: 1001,
        },
      },
      nowSecs: 1001,
    })

    // Edit 2: set emotion, title is preserved from priorIntent
    const intent2 = buildOutboxIntent({
      entryId: 'entry-exist-1',
      webDeviceId: 'web-1',
      createdOnWeb: false,
      baseSyncedDocBytes: baseBytes,
      priorIntent: intent1,
      localDocBytes: baseBytes,
      contentText: '',
      previewText: '',
      newFields: {
        emotion: {
          value: 'good',
          base: null,
          base_updated_at: 1000,
          change_seq: 2,
          changed_at_secs: 1002,
        },
      },
      nowSecs: 1002,
    })

    expect(intent2.fields.title?.value).toBe('Title 1')
    expect(intent2.fields.emotion?.value).toBe('good')
  })
})

describe('upload packing order', () => {
  it('places media and thumb intents strictly before entry intent', () => {
    const entry: OutboxEntryV1 = {
      schema_version: 1,
      entry_id: '11111111-1111-1111-1111-111111111111',
      web_device_id: '22222222-2222-2222-2222-222222222222',
      created_on_web: true,
      web_updated_at_secs: 1700000000,
      base_state_vector: [],
      yjs_full_state: [],
      content_text: null,
      preview_text: null,
      fields: createEmptyOutboxFields(),
      media: [
        {
          media_id: '33333333-3333-3333-3333-333333333333',
          file_name: 'test.jpg',
          file_type: 'image/jpeg',
          size: 100,
          has_thumb: true,
        },
      ],
    }

    const sealedMediaMap = new Map([
      ['33333333-3333-3333-3333-333333333333', new Uint8Array([10, 20])],
    ])
    const plainMediaMap = new Map([
      ['33333333-3333-3333-3333-333333333333', new Uint8Array([1, 2])],
    ])
    const sealedThumbMap = new Map([
      ['33333333-3333-3333-3333-333333333333', new Uint8Array([30, 40])],
    ])
    const plainThumbMap = new Map([
      ['33333333-3333-3333-3333-333333333333', new Uint8Array([3, 4])],
    ])
    const sealedEntryBytes = new Uint8Array([50, 60])

    const intents = packOutboxUploadIntents({
      localGen: 0,
      ownDeviceId: '22222222-2222-2222-2222-222222222222',
      entry,
      sealedEntryBytes,
      sealedMediaMap,
      plainMediaMap,
      sealedThumbMap,
      plainThumbMap,
    })

    expect(intents).toHaveLength(3)
    expect(intents[0].intended.kind).toBe('media')
    expect(intents[0].path).toBe(
      'generations/g-0/22222222-2222-2222-2222-222222222222/outbox/m-33333333-3333-3333-3333-333333333333',
    )
    expect(intents[1].intended.kind).toBe('thumb')
    expect(intents[1].path).toBe(
      'generations/g-0/22222222-2222-2222-2222-222222222222/outbox/m-33333333-3333-3333-3333-333333333333.thumb',
    )
    expect(intents[2].intended.kind).toBe('entry')
    expect(intents[2].path).toBe(
      'generations/g-0/22222222-2222-2222-2222-222222222222/outbox/11111111-1111-1111-1111-111111111111.bin',
    )

    for (const intent of intents) {
      expect(isIntentPathValid(intent.path, 0, '22222222-2222-2222-2222-222222222222')).toBe(true)
      // Path must be strictly within outbox/
      expect(intent.path).toMatch(
        /^generations\/g-0\/22222222-2222-2222-2222-222222222222\/outbox\//,
      )
      expect(intent.path.includes('/entries/')).toBe(false)
      expect(intent.path.includes('/metadata.json')).toBe(false)
    }

    // Overwritten in place: re-packing the same entry produces the identical outbox path
    const intent2 = packOutboxUploadIntents({
      localGen: 0,
      ownDeviceId: '22222222-2222-2222-2222-222222222222',
      entry,
      sealedEntryBytes: new Uint8Array([77, 88]),
      sealedMediaMap: new Map(),
      plainMediaMap: new Map(),
      sealedThumbMap: new Map(),
      plainThumbMap: new Map(),
    })
    expect(intent2[0].path).toBe(intents[2].path)
  })

  it('guarantees all timestamps are integer seconds', () => {
    const nowSecs = 1700000000
    const intent = buildOutboxIntent({
      entryId: 'entry-ts-1',
      webDeviceId: 'web-1',
      createdOnWeb: true,
      baseSyncedDocBytes: null,
      priorIntent: null,
      localDocBytes: null,
      contentText: '',
      previewText: '',
      newFields: {
        title: {
          value: 'T',
          base: '',
          base_updated_at: 1699999000,
          change_seq: 1,
          changed_at_secs: nowSecs,
        },
      },
      nowSecs,
    })

    expect(Number.isInteger(intent.web_updated_at_secs)).toBe(true)
    expect(intent.web_updated_at_secs).toBeLessThan(10_000_000_000)
    expect(Number.isInteger(intent.fields.title!.changed_at_secs)).toBe(true)
    expect(intent.fields.title!.changed_at_secs).toBeLessThan(10_000_000_000)
    expect(Number.isInteger(intent.fields.title!.base_updated_at)).toBe(true)
  })
})

describe('retention rules (desktop ack format)', () => {
  const PATH = 'web-1/outbox/e1.bin'
  const synced: EntryMetadata = {
    entry_id: 'e1',
    device_id: 'desk-a',
    updated_at: 1000,
    entry_date: 1000,
    created_at: 1000,
    journal_id: 'j1',
    journal_name: null,
    title: 'Old',
    preview_text: '',
    content_text: '',
    emotion: null,
    is_favorite: false,
    is_deleted: false,
    is_locked: false,
    is_invisible: false,
    vault_id: null,
    tag_ids: [],
  }
  const title: FieldChange<string> = {
    value: 'New',
    base: 'Old',
    base_updated_at: 1000,
    change_seq: 7,
    changed_at_secs: 5,
  }
  const decision = (
    desktop: string,
    d: {
      decision: string
      reason?: string | null
      at?: number
      path?: string
      seq?: number
      field?: string
    },
  ): OutboxAcksV1 => ({
    schema_version: 1,
    desktop_device_id: desktop,
    acks: [
      {
        path: d.path ?? PATH,
        content_hash: 'h',
        applied_updated_at: null,
        created: false,
        refused_reason: null,
        decided: [
          {
            field: d.field ?? 'title',
            change_seq: d.seq ?? 7,
            decision: d.decision,
            decided_updated_at: d.at ?? 1100,
            reason: d.reason ?? null,
          },
        ],
      },
    ],
  })
  const resolve = (acks: OutboxAcksV1[], extra: Partial<Parameters<typeof resolveField>[0]> = {}) =>
    resolveField({
      fieldName: 'title',
      change: title,
      syncedEntry: { ...synced, updated_at: 1200 },
      allAcks: acks,
      intentPath: PATH,
      capableDesktops: ['desk-a'],
      nowSecs: 10,
      entryTitleOrId: 'Old',
      ...extra,
    })

  it("ignores decisions recorded for another web device's intent path", () => {
    const other = decision('desk-a', { decision: 'refused', path: 'web-2/outbox/e1.bin' })
    expect(resolve([other]).resolved).toBe(false)
  })

  it('treats an empty refusal reason (what the desktop writes) as a conflict', () => {
    const res = resolve([decision('desk-a', { decision: 'refused', reason: null })])
    expect(res).toEqual({
      resolved: true,
      notice: {
        kind: 'replaced',
        field: 'title',
        title: 'Old',
        change_seq: 7,
      },
    })
  })

  it('a conflict refusal stays pending while the synced entry is still at base', () => {
    const res = resolve([decision('desk-a', { decision: 'refused' })], { syncedEntry: synced })
    expect(res.resolved).toBe(false)
  })

  it('any other refusal reason is deterministic and final once every desktop decided', () => {
    const a = decision('desk-a', { decision: 'refused', reason: 'tag_not_found' })
    const pending = resolve([a], { capableDesktops: ['desk-a', 'desk-b'], syncedEntry: synced })
    expect(pending.resolved).toBe(false)
    const b = decision('desk-b', { decision: 'refused', reason: 'tag_not_found' })
    const final = resolve([a, b], { capableDesktops: ['desk-a', 'desk-b'], syncedEntry: synced })
    expect(final.notice).toEqual({
      kind: 'refused',
      field: 'title',
      title: 'Old',
      reason: 'tag_not_found',
      change_seq: 7,
    })
  })

  it('passes an unknown desktop refusal code through as the reason', () => {
    const a = decision('desk-a', { decision: 'refused', reason: 'some_future_code' })
    const res = resolve([a], { syncedEntry: synced })
    expect(res.notice).toMatchObject({ kind: 'refused', reason: 'some_future_code' })
  })

  it('carries the raw tag field key, never an English label', () => {
    const field = 'tag_add:7f9c2d1e-0000-4000-8000-000000000001'
    const res = resolve(
      [decision('desk-a', { decision: 'refused', reason: 'tag_not_found', field })],
      {
        fieldName: field,
        change: {
          value: true,
          base: false,
          base_updated_at: 1000,
          change_seq: 7,
          changed_at_secs: 5,
        },
        syncedEntry: synced,
      },
    )
    expect(res.notice).toMatchObject({ kind: 'refused', field, reason: 'tag_not_found' })
  })

  function docBytes(text: string, base?: Uint8Array): Uint8Array {
    const doc = new Y.Doc()
    if (base) Y.applyUpdate(doc, base)
    doc.getText('t').insert(0, text)
    return Y.encodeStateAsUpdate(doc)
  }

  const intentOf = (over: Partial<OutboxEntryV1> = {}): OutboxEntryV1 => ({
    schema_version: 1,
    entry_id: 'e1',
    web_device_id: 'web-1',
    created_on_web: false,
    web_updated_at_secs: 5,
    base_state_vector: [],
    yjs_full_state: [],
    content_text: null,
    preview_text: null,
    fields: createEmptyOutboxFields(),
    media: [],
    ...over,
  })

  const retain = (over: Partial<RetainParams>) =>
    shouldRetainIntent({
      intent: intentOf(),
      intentPath: PATH,
      contentHash: 'h',
      syncedEntry: synced,
      syncedContent: null,
      tombstoned: false,
      allAcks: [],
      capableDesktops: ['desk-a'],
      nowSecs: 10,
      ...over,
    })

  it('keeps an intent whose Yjs edit the synced doc does not contain yet, drops it once merged', () => {
    const base = docBytes('desktop ')
    const edit = docBytes('web ', base)
    const intent = intentOf({ yjs_full_state: Array.from(edit) })
    expect(retain({ intent, syncedContent: base }).retain).toBe(true)
    // The desktop merged it and added text of its own after: no clock is compared.
    const merged = docBytes('more ', edit)
    expect(retain({ intent, syncedContent: merged }).retain).toBe(false)
  })

  it('keeps an intent until every media id is in the synced metadata', () => {
    const intent = intentOf({
      media: [
        { media_id: 'm1', file_name: 'a', file_type: 'image/jpeg', size: 1, has_thumb: false },
      ],
    })
    expect(retain({ intent }).retain).toBe(true)
    expect(retain({ intent, syncedEntry: { ...synced, media: [{ id: 'm1' }] } }).retain).toBe(false)
  })

  it('drops on a tombstone in any manifest, and on a locked or invisible synced entry', () => {
    const intent = intentOf({ fields: { ...createEmptyOutboxFields(), title } })
    expect(retain({ intent }).retain).toBe(true)
    expect(retain({ intent, tombstoned: true, syncedEntry: null }).retain).toBe(false)
    expect(retain({ intent, syncedEntry: { ...synced, is_locked: true } }).retain).toBe(false)
    expect(retain({ intent, syncedEntry: { ...synced, is_invisible: true } }).retain).toBe(false)
  })

  it('omits fields resolved earlier (persisted keys) without a second notice', () => {
    const intent = intentOf({ fields: { ...createEmptyOutboxFields(), title } })
    const res = retain({ intent, resolvedKeys: new Set(['title@7']) })
    expect(res.cleanedFields.title).toBeNull()
    expect(res.fieldNotices).toEqual([])
    expect(res.retain).toBe(false)
  })

  describe('create refused', () => {
    const created = intentOf({ created_on_web: true })
    const ack = (desktop: string, hash: string, refused: string | null, isCreated = false) => ({
      schema_version: 1,
      desktop_device_id: desktop,
      acks: [
        {
          path: PATH,
          content_hash: hash,
          applied_updated_at: null,
          created: isCreated,
          refused_reason: refused,
          decided: [],
        },
      ],
    })
    const base = { intent: created, syncedEntry: null, capableDesktops: ['desk-a', 'desk-b'] }

    it('drops with a notice once every capable desktop refused the current revision', () => {
      const one = retain({ ...base, allAcks: [ack('desk-a', 'h', 'no_journal')] })
      expect(one.retain).toBe(true)
      const both = retain({
        ...base,
        allAcks: [ack('desk-a', 'h', 'no_journal'), ack('desk-b', 'h', 'no_journal')],
      })
      expect(both.retain).toBe(false)
      // An entry-level refusal: no `field`, the raw desktop code as the reason.
      // The draft has no title, so the notice carries no `title` key.
      expect(both.notice).toEqual({ kind: 'refused', reason: 'no_journal' })
    })

    it('names the refused draft by its title when it has one', () => {
      const res = retain({
        ...base,
        intent: intentOf({
          created_on_web: true,
          fields: { ...createEmptyOutboxFields(), title },
        }),
        allAcks: [ack('desk-a', 'h', 'no_journal'), ack('desk-b', 'h', 'no_journal')],
      })
      expect(res.retain).toBe(false)
      expect(res.notice).toEqual({ kind: 'refused', title: title.value, reason: 'no_journal' })
    })

    it('ignores refusals of an older revision and is overridden by any created: true', () => {
      const stale = retain({
        ...base,
        allAcks: [ack('desk-a', 'old', 'no_journal'), ack('desk-b', 'old', 'no_journal')],
      })
      expect(stale.retain).toBe(true)
      const createdElsewhere = retain({
        ...base,
        allAcks: [ack('desk-a', 'h', 'no_journal'), ack('desk-b', 'old', 'absent', true)],
      })
      expect(createdElsewhere.retain).toBe(true)
    })
  })
})
