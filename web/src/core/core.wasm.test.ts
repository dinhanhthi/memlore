import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as Y from 'yjs'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadCore, type Core } from './core'

const ABANDON_ART = `${'abandon '.repeat(23)}art`

describe('loadCore', () => {
  it('is idempotent', async () => {
    expect(await loadCore()).toBe(await loadCore())
  })

  it('exposes knownVersions with payload_schema_version 1', async () => {
    const core = await loadCore()
    expect(JSON.parse(core.knownVersions()).payload_schema_version).toBe(1)
  })

  it('validates mnemonics', async () => {
    const core = await loadCore()
    expect(core.validateMnemonic(ABANDON_ART)).toBe(true)
    expect(core.validateMnemonic('not a real phrase')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// HARD GATE: desktop -> web. The frozen v0.1.0 desktop vault must open in WASM.
// ---------------------------------------------------------------------------

interface ExpectedEntry {
  entry_id: string
  title: string
  content_text: string
  emotion: string | null
  is_favorite: boolean
  is_locked: boolean
  journal_name: string
  media_ids: string[]
  tags: string[]
}

interface ExpectedMedia {
  media_id: string
  bytes_b64: string
  thumb_b64: string
}

type Ring = ReturnType<Core['KeyRing']['fromRecovery']>

interface Fixture {
  files: Record<string, string>
  recovery_phrase: string
  device_id: string
  generation: number
  expected: { entries: ExpectedEntry[]; media: ExpectedMedia[]; tags: string[] }
}

interface EntryMeta {
  title: string | null
  content_text: string | null
  emotion: string | null
  is_favorite: boolean
  is_locked: boolean
  journal_name: string | null
  tag_ids: string[]
  media: unknown[]
}

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../../src-tauri/crates/memlore-core/fixtures/desktop-vault.v1.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
) as Fixture

const file = (path: string): Uint8Array =>
  new Uint8Array(Buffer.from(fixture.files[path], 'base64'))
const text = (path: string): string => Buffer.from(fixture.files[path], 'base64').toString('utf8')
const base = `generations/g-${fixture.generation}/${fixture.device_id}`
const entryPath = (id: string): string => `${base}/entries/${id}.bin`
const ZERO_PHRASE = fixture.recovery_phrase
// Another valid 24-word phrase (BIP39 test vector, all 0xff entropy).
const OTHER_PHRASE = `${'zoo '.repeat(23)}vote`

const recoveryJson = JSON.parse(text('.meta/keyring/_recovery.json')) as { wrapped_master: string }
const keyringMeta = JSON.parse(text('.meta/keyring/_meta.json')) as { master_fingerprint: string }

function yjsText(bytes: Uint8Array): string {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, bytes)
  return doc.getText('content').toString()
}

describe('desktop vault fixture opens in WASM (hard gate)', () => {
  let core: Core
  let ring: Ring

  const unlock = (): Ring => {
    const r = core.KeyRing.fromRecovery(
      ZERO_PHRASE,
      recoveryJson.wrapped_master,
      keyringMeta.master_fingerprint,
    )
    r.loadContentList(text('.meta/keyring/_content.json'))
    return r
  }

  beforeAll(async () => {
    core = await loadCore()
    ring = unlock()
  })

  it('fixture has 7 expected entries', () => {
    expect(fixture.expected.entries).toHaveLength(7)
  })

  it('opens every entry with the expected plaintext and Yjs text', () => {
    for (const e of fixture.expected.entries) {
      const opened = core.openEntry(ring, file(entryPath(e.entry_id)))
      const m = JSON.parse(opened.metadataJson) as EntryMeta
      expect(m.title).toBe(e.title)
      expect(m.content_text).toBe(e.content_text)
      expect(m.emotion).toBe(e.emotion)
      expect(m.is_favorite).toBe(e.is_favorite)
      expect(m.journal_name).toBe(e.journal_name)
      expect(m.tag_ids).toHaveLength(e.tags.length)
      expect(m.media).toHaveLength(e.media_ids.length)
      expect(yjsText(opened.yjs)).toBe(e.content_text)
    }
  })

  it('flags only the locked entry as locked', () => {
    const locked = fixture.expected.entries.filter((e) => e.is_locked)
    expect(locked).toHaveLength(1)
    for (const e of fixture.expected.entries) {
      const m = JSON.parse(
        core.openEntry(ring, file(entryPath(e.entry_id))).metadataJson,
      ) as EntryMeta
      expect(m.is_locked).toBe(e.is_locked)
    }
  })

  it('opens media and thumbnail to the expected bytes', () => {
    expect(fixture.expected.media).toHaveLength(1)
    for (const m of fixture.expected.media) {
      const full = core.openMedia(ring, file(`${base}/media/${m.media_id}`))
      const thumb = core.openMedia(ring, file(`${base}/media/${m.media_id}.thumb`))
      expect(Buffer.from(full).toString('base64')).toBe(m.bytes_b64)
      expect(Buffer.from(thumb).toString('base64')).toBe(m.thumb_b64)
    }
  })

  it('opens every device bin and tags.bin carries the expected tag names', () => {
    const bins = Object.keys(fixture.files).filter(
      (p) =>
        p.startsWith(`${base}/`) &&
        p.endsWith('.bin') &&
        p.slice(base.length + 1).indexOf('/') === -1,
    )
    expect(bins.length).toBeGreaterThanOrEqual(7)
    for (const p of bins) {
      const plain = Buffer.from(core.openDeviceBin(ring, file(p))).toString('utf8')
      expect(() => JSON.parse(plain) as unknown).not.toThrow()
    }
    const tags = Buffer.from(core.openDeviceBin(ring, file(`${base}/tags.bin`))).toString('utf8')
    for (const name of fixture.expected.tags) expect(tags).toContain(name)
  })

  it('verifyMasterFingerprint accepts the right fingerprint and rejects a wrong one', () => {
    expect(() => core.verifyMasterFingerprint(ring, keyringMeta.master_fingerprint)).not.toThrow()
    expect(() => core.verifyMasterFingerprint(ring, '0'.repeat(64))).toThrow()
  })

  it('rejects a wrong but valid phrase and an invalid phrase', () => {
    expect(core.validateMnemonic(OTHER_PHRASE)).toBe(true)
    const fp = keyringMeta.master_fingerprint
    expect(() => core.KeyRing.fromRecovery(OTHER_PHRASE, recoveryJson.wrapped_master, fp)).toThrow()
    expect(() =>
      core.KeyRing.fromRecovery('not a real phrase', recoveryJson.wrapped_master, fp),
    ).toThrow()
  })

  it('rejects the right phrase against a wrong fingerprint', () => {
    expect(() =>
      core.KeyRing.fromRecovery(ZERO_PHRASE, recoveryJson.wrapped_master, '0'.repeat(64)),
    ).toThrow()
  })

  it('cannot open before the content list is loaded', () => {
    const bare = core.KeyRing.fromRecovery(
      ZERO_PHRASE,
      recoveryJson.wrapped_master,
      keyringMeta.master_fingerprint,
    )
    expect(() =>
      core.openEntry(bare, file(entryPath(fixture.expected.entries[0].entry_id))),
    ).toThrow()
  })

  it('parses the plaintext manifest to the 7 entries', () => {
    const manifest = core.parseManifest(text(`${base}/metadata.json`))
    const parsed = JSON.parse(manifest) as { device_id: string; entries: { entry_id: string }[] }
    expect(parsed.device_id).toBe(fixture.device_id)
    expect(parsed.entries).toHaveLength(7)
    const empty = JSON.stringify({ device_id: 'local', entries: [], journals: [], generated_at: 0 })
    const diff = JSON.parse(core.computeDiff(empty, manifest)) as { to_pull: string[] }
    expect([...diff.to_pull].sort()).toEqual(fixture.expected.entries.map((e) => e.entry_id).sort())
  })

  it('parses the .meta keyring, control and device slot files', () => {
    expect(() => core.parseKeyringMeta(text('.meta/keyring/_meta.json'))).not.toThrow()
    expect(() => core.parseSyncControl(text('.meta/control.json'))).not.toThrow()
    const slot = `.meta/keyring/devices/${fixture.device_id}.json`
    const parsed = JSON.parse(core.parseDeviceSlot(text(slot))) as { device_id: string }
    expect(parsed.device_id).toBe(fixture.device_id)
  })

  it('fails closed on a tampered ciphertext byte', () => {
    const id = fixture.expected.entries[0].entry_id
    const bytes = file(entryPath(id))
    bytes[bytes.length - 1] ^= 0x01
    expect(() => core.openEntry(ring, bytes)).toThrow()
    const mediaId = fixture.expected.media[0].media_id
    const media = file(`${base}/media/${mediaId}`)
    media[media.length - 1] ^= 0x01
    expect(() => core.openMedia(ring, media)).toThrow()
  })

  it('fails every open after lock()', () => {
    const r = unlock()
    expect(r.isLocked).toBe(false)
    r.lock()
    expect(r.isLocked).toBe(true)
    const id = fixture.expected.entries[0].entry_id
    expect(() => core.openEntry(r, file(entryPath(id)))).toThrow()
    expect(() =>
      core.openMedia(r, file(`${base}/media/${fixture.expected.media[0].media_id}`)),
    ).toThrow()
    expect(() => core.openDeviceBin(r, file(`${base}/tags.bin`))).toThrow()
  })
})
