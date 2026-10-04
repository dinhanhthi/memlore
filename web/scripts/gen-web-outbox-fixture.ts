import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as Y from 'yjs'
import * as core from '../src/core/pkg-test/memlore_wasm.js'
import { buildOutboxIntent } from '../src/backend/sync/outbox.ts'

const fixturesDir = new URL('../../src-tauri/crates/memlore-core/fixtures/', import.meta.url)
const outPath = fileURLToPath(new URL('web-outbox.v1.json', fixturesDir))
const vaultPath = fileURLToPath(new URL('desktop-vault.v1.json', fixturesDir))

if (existsSync(outPath) && process.env.MEMLORE_REGEN_FIXTURES !== '1') {
  console.error(
    `Refusing to overwrite ${outPath}: it is a frozen cross-language oracle.\n` +
      'If a deliberate, reviewed fixture change is really needed, run:\n' +
      '  MEMLORE_REGEN_FIXTURES=1 pnpm web:fixture:outbox',
  )
  process.exit(1)
}

interface Vault {
  files: Record<string, string>
  recovery_phrase: string
}

const vault = JSON.parse(readFileSync(vaultPath, 'utf8')) as Vault
const text = (path: string): string => Buffer.from(vault.files[path], 'base64').toString('utf8')
const recovery = JSON.parse(text('.meta/keyring/_recovery.json')) as { wrapped_master: string }
const meta = JSON.parse(text('.meta/keyring/_meta.json')) as { master_fingerprint: string }

core.initSync({
  module: readFileSync(new URL('../src/core/pkg-test/memlore_wasm_bg.wasm', import.meta.url)),
})
const ring = core.KeyRing.fromRecovery(
  vault.recovery_phrase,
  recovery.wrapped_master,
  meta.master_fingerprint,
)
ring.loadContentList(text('.meta/keyring/_content.json'))

const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64')

const webDeviceId = '00000000-0000-0000-0000-000000000002'
const slotJson = core.buildDeviceSlot(webDeviceId, 'Web Companion', 1700000000, 1700000000)

const files: Record<string, string> = {}
files[`.meta/keyring/devices/${webDeviceId}.json`] = b64(Buffer.from(slotJson, 'utf8'))

// 1. Created entry with media & thumbnail (exercises create-then-re-edit on web)
const createdEntryId = '00000000-0000-0000-0000-000000000010'
const mediaId = '00000000-0000-0000-0000-000000000020'
const mediaPlain = Uint8Array.from({ length: 120 }, (_, i) => (i * 3 + 1) % 256)
const thumbPlain = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9])

const sealedMedia = core.sealOutboxMedia(ring, mediaPlain)
const sealedThumb = core.sealOutboxThumb(ring, thumbPlain)
files[`generations/g-0/${webDeviceId}/outbox/m-${mediaId}`] = b64(sealedMedia)
files[`generations/g-0/${webDeviceId}/outbox/m-${mediaId}.thumb`] = b64(sealedThumb)

// 1a. Initial draft creation
const doc1 = new Y.Doc()
const text1 = doc1.getText('content')
text1.insert(0, 'Initial draft')
const initialYjs = Y.encodeStateAsUpdate(doc1)

const initialIntent = buildOutboxIntent({
  entryId: createdEntryId,
  webDeviceId,
  createdOnWeb: true,
  baseSyncedDocBytes: null,
  priorIntent: null,
  localDocBytes: initialYjs,
  contentText: 'Initial draft',
  previewText: 'Initial draft',
  newFields: {
    title: {
      value: 'Initial Title',
      base: '',
      base_updated_at: 0,
      change_seq: 1,
      changed_at_secs: 1700000005,
    },
    journal_id: {
      value: '4fd64221-d0eb-4bc0-84c9-810bce934d16',
      base: '',
      base_updated_at: 0,
      change_seq: 2,
      changed_at_secs: 1700000005,
    },
  },
  mediaRefs: [],
  nowSecs: 1700000005,
})

// 1b. Re-edit before any desktop sync occurs
const doc2 = new Y.Doc()
Y.applyUpdate(doc2, initialYjs)
const text2 = doc2.getText('content')
text2.delete(0, text2.length)
text2.insert(0, `Web created body with image <img data-media-id="${mediaId}">`)
const reeditYjs = Y.encodeStateAsUpdate(doc2)

const createdEntry = buildOutboxIntent({
  entryId: createdEntryId,
  webDeviceId,
  createdOnWeb: true,
  baseSyncedDocBytes: null,
  priorIntent: initialIntent,
  localDocBytes: reeditYjs,
  contentText: 'Web created body with image',
  previewText: 'Web created body with image',
  newFields: {
    title: {
      value: 'Web Created Entry',
      base: '',
      base_updated_at: 0,
      change_seq: 3,
      changed_at_secs: 1700000010,
    },
  },
  mediaRefs: [
    {
      media_id: mediaId,
      file_name: 'golden.png',
      file_type: 'image/png',
      size: mediaPlain.length,
      has_thumb: true,
    },
  ],
  nowSecs: 1700000010,
})
const sealedCreated = core.sealOutboxEntry(ring, JSON.stringify(createdEntry))
files[`generations/g-0/${webDeviceId}/outbox/${createdEntryId}.bin`] = b64(sealedCreated)

// 2. Edit of desktop entry 0 (5b7d3a8f-bd0c-4178-94b7-69d19959fecf: "Golden one", "First golden body")
const editedEntryId = '5b7d3a8f-bd0c-4178-94b7-69d19959fecf'
const entry0Raw = Buffer.from(
  vault.files[
    'generations/g-0/9c5eba44-ed3f-4dae-a3c7-31c0d96792dd/entries/5b7d3a8f-bd0c-4178-94b7-69d19959fecf.bin'
  ],
  'base64',
)
const opened0 = core.openEntry(ring, entry0Raw)
const meta0 = JSON.parse(opened0.metadataJson || opened0.metadata_json)
const baseUpdatedAt = Number(meta0.updated_at)
const editDoc = new Y.Doc()
Y.applyUpdate(editDoc, opened0.yjs)
const editText = editDoc.getText('content')
editText.insert(editText.length, ' + Web append text')
const editedYjs = Y.encodeStateAsUpdate(editDoc)

const editedEntry = buildOutboxIntent({
  entryId: editedEntryId,
  webDeviceId,
  createdOnWeb: false,
  baseSyncedDocBytes: opened0.yjs,
  priorIntent: null,
  localDocBytes: editedYjs,
  contentText: 'First golden body + Web append text',
  previewText: 'First golden body',
  newFields: {
    title: {
      value: 'Golden one edited by web',
      base: 'Golden one',
      base_updated_at: baseUpdatedAt,
      change_seq: 10,
      changed_at_secs: 1700000020,
    },
    emotion: {
      value: 'good',
      base: null,
      base_updated_at: baseUpdatedAt,
      change_seq: 11,
      changed_at_secs: 1700000020,
    },
    is_favorite: {
      value: true,
      base: false,
      base_updated_at: baseUpdatedAt,
      change_seq: 12,
      changed_at_secs: 1700000020,
    },
    journal_id: {
      value: '4fd64221-d0eb-4bc0-84c9-810bce934d16',
      base: '',
      base_updated_at: baseUpdatedAt,
      change_seq: 13,
      changed_at_secs: 1700000020,
    },
  },
  mediaRefs: [],
  nowSecs: 1700000020,
})
const sealedEdited = core.sealOutboxEntry(ring, JSON.stringify(editedEntry))
files[`generations/g-0/${webDeviceId}/outbox/${editedEntryId}.bin`] = b64(sealedEdited)

// 3. Locked entry intent (625b02b7-f56e-47b0-95bf-5ba5da3f4d32: "Golden six")
const lockedEntryId = '625b02b7-f56e-47b0-95bf-5ba5da3f4d32'
const lockedEntry = buildOutboxIntent({
  entryId: lockedEntryId,
  webDeviceId,
  createdOnWeb: false,
  baseSyncedDocBytes: null,
  priorIntent: null,
  localDocBytes: null,
  contentText: null,
  previewText: null,
  newFields: {
    title: {
      value: 'Locked title edited by web',
      base: 'Golden six',
      base_updated_at: 0,
      change_seq: 20,
      changed_at_secs: 1700000030,
    },
  },
  mediaRefs: [],
  nowSecs: 1700000030,
})
const sealedLocked = core.sealOutboxEntry(ring, JSON.stringify(lockedEntry))
files[`generations/g-0/${webDeviceId}/outbox/${lockedEntryId}.bin`] = b64(sealedLocked)

// 4. Unsupported version intent
const unsupportedEntryId = '00000000-0000-0000-0000-000000000088'
const dummyEntry = {
  schema_version: 1,
  entry_id: unsupportedEntryId,
  web_device_id: webDeviceId,
  created_on_web: true,
  web_updated_at_secs: 1700000040,
  base_state_vector: [],
  yjs_full_state: [],
  content_text: null,
  preview_text: null,
  fields: {
    title: null,
    entry_date: null,
    emotion: null,
    is_favorite: null,
    journal_id: null,
    tags_add: {},
    tags_remove: {},
  },
  media: [],
}
const sealedDummy = core.sealOutboxEntry(ring, JSON.stringify(dummyEntry))
// Corrupt schema_version byte (after 4-byte magic XJO1, little-endian u16 schema_version = 99 -> 0x63, 0x00)
sealedDummy[4] = 99
files[`generations/g-0/${webDeviceId}/outbox/${unsupportedEntryId}.bin`] = b64(sealedDummy)

const out = {
  _comment:
    'Generated by `pnpm web:fixture:outbox` (WASM sealers, keys of desktop-vault.v1.json). ' +
    'FROZEN cross-language oracle: never regenerate casually, fix the code instead.',
  vault_fixture: 'desktop-vault.v1.json',
  web_device_id: webDeviceId,
  files,
  expected: {
    created_entry_id: createdEntryId,
    edited_entry_id: editedEntryId,
    media_id: mediaId,
    locked_entry_id: lockedEntryId,
    unsupported_entry_id: unsupportedEntryId,
  },
}

writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`)
ring.lock()
console.log(`wrote ${outPath}`)
