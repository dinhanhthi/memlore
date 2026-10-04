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
} from './outbox'
import type { EntryMetadata } from '../vault'

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
          path: 'generations/g-0/web-1/outbox/entry-1.bin',
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
          path: 'generations/g-0/web-1/outbox/entry-1.bin',
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
          path: 'generations/g-0/web-1/outbox/entry-1.bin',
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
      capableDesktops: ['desktop-a'],
      nowSecs: 2600,
      entryTitleOrId: 'Original Title',
    })

    expect(res.resolved).toBe(true)
    expect(res.notice).toEqual({
      kind: 'replaced',
      text: 'This edit was replaced by a change from your desktop: title of Original Title',
    })
  })

  it('deterministic refusal is final when every capable desktop decides', () => {
    const acksA: OutboxAcksV1 = {
      schema_version: 1,
      desktop_device_id: 'desktop-a',
      acks: [
        {
          path: 'generations/g-0/web-1/outbox/entry-1.bin',
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
      capableDesktops: ['desktop-a'],
      nowSecs: 1200,
      entryTitleOrId: 'Original Title',
    })

    expect(res.resolved).toBe(true)
    expect(res.notice).toEqual({
      kind: 'refused',
      text: 'Your desktop could not apply: journal',
    })
  })

  it('conflict refusal: waits for all desktops or 30 days', () => {
    const acksB: OutboxAcksV1 = {
      schema_version: 1,
      desktop_device_id: 'desktop-b',
      acks: [
        {
          path: 'generations/g-0/web-1/outbox/entry-1.bin',
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
      expect(
        isIntentPathValid(
          intent.path,
          0,
          '22222222-2222-2222-2222-222222222222',
        ),
      ).toBe(true)
      // Path must be strictly within outbox/
      expect(intent.path).toMatch(/^generations\/g-0\/22222222-2222-2222-2222-222222222222\/outbox\//)
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
