import { IDBFactory } from 'fake-indexeddb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Core } from '../../core/core'
import {
  DriveHttpError,
  DriveNotFoundError,
  DriveReader,
  DriveTooLargeError,
} from '../drive/client'
import { FakeDrive } from '../drive/fakeDrive'
import { VaultLockedError, type KeyRing } from '../keys'
import { WRAPPED_MASTER_HEX_LEN, openWebDb, type WebDb } from '../storage/idb'
import { createLimiter } from '../sync/pull'
import { EntryUnavailableError, type VaultEntry } from '../vault'
import {
  ENVELOPE_OVERHEAD_BYTES,
  MAX_THUMB_BYTES,
  MAX_WEB_MEDIA_BYTES,
  TOO_LARGE_FOR_NUMBER_ARRAY,
  TOUCH_INTERVAL_MS,
  MediaCorruptError,
  MediaNotFoundError,
  MediaTransientError,
  MediaSizeMismatchError,
  TooLargeForWebError,
  configureMediaEnv,
  mediaHandlers,
} from './media'
import { EMPTY_TAXONOMY } from './readTestKit'
import { configureReadEnv, type MediaBackend, type VaultApi } from './readSession'

const OWNER = 'aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb'
const OTHER = 'dddddddd-2222-4333-8444-eeeeeeeeeeee'
const MID = '32bd8743-077d-4312-b6ff-9cd896e09d1b'
const PLAIN = new TextEncoder().encode('PLAINTEXT-MARKER-photo')
const THUMB_PLAIN = new TextEncoder().encode('thumb-bytes')

/** Fake envelope: `[version, ...plain XOR 0x5a]`; a leading `0xff` is "tampered". */
const seal = (plain: Uint8Array, version = 0x02): Uint8Array =>
  Uint8Array.from([version, ...plain.map((b) => b ^ 0x5a)])
const fakeCore: Pick<Core, 'openMedia'> = {
  openMedia: (_ring, bytes) => {
    if (bytes[0] !== 1 && bytes[0] !== 2) throw new Error('bad envelope')
    return bytes.slice(1).map((b) => b ^ 0x5a)
  },
}

interface Spec {
  id?: string
  entryId?: string
  device?: string
  fileType?: string
  fileSize?: number | null
  createdAt?: number
  isOutbox?: boolean
  outboxDevice?: string
}

function entryWith(spec: Spec, extra: Record<string, unknown> = {}): VaultEntry {
  const metadata = {
    entry_id: spec.entryId ?? 'entry-1',
    device_id: spec.device ?? OWNER,
    updated_at: 1,
    entry_date: 1,
    created_at: 1,
    journal_id: 'j1',
    journal_name: null,
    title: 't',
    preview_text: null,
    content_text: null,
    emotion: null,
    is_favorite: false,
    is_deleted: false,
    is_locked: false,
    is_invisible: false,
    vault_id: null,
    tag_ids: [],
    media: [
      {
        id: spec.id ?? MID,
        file_name: 'a.png',
        file_type: spec.fileType ?? 'image/png',
        file_size: spec.fileSize === undefined ? 10 : spec.fileSize,
        created_at: spec.createdAt ?? 5,
        width: 4,
        height: 3,
        ...(spec.isOutbox ? { is_outbox: true } : {}),
        ...(spec.outboxDevice ? { outbox_device: spec.outboxDevice } : {}),
      },
    ],
    ...extra,
  }
  return { metadata, content: new Uint8Array(0), contentText: '', previewText: '', loadedAt: 0 }
}

class FakeReader {
  readonly calls: string[] = []
  /** The `maxBytes` of every request, as passed by the media code. */
  readonly caps: Array<number | undefined> = []
  readonly files = new Map<string, Uint8Array>()
  failWith: Error | null = null
  gate: Promise<void> | null = null

  /** Emulates the real reader's cap: a body over `maxBytes` is refused. */
  readonly readDeviceFile = async (
    generation: number,
    path: string,
    maxBytes?: number,
  ): Promise<Uint8Array> => {
    this.calls.push(`${generation}:${path}`)
    this.caps.push(maxBytes)
    if (this.gate !== null) await this.gate
    if (this.failWith !== null) throw this.failWith
    const bytes = this.files.get(path)
    if (bytes === undefined) throw new DriveNotFoundError(path)
    if (maxBytes !== undefined && bytes.length > maxBytes) throw new DriveTooLargeError(maxBytes)
    return bytes
  }
}

interface Rig {
  reader: FakeReader
  db: WebDb
  limitedRuns: { count: number }
  /** Counts `openMedia` calls. */
  opens: { count: number }
  setUnlocked: (v: boolean) => void
  setLoaded: (entries: VaultEntry[]) => void
  /** Entries `listLoaded` reports although `getEntry` refuses them (a locked entry leak). */
  setLeaked: (entries: VaultEntry[]) => void
  clock: { now: number }
}

async function rig(
  entries: VaultEntry[] = [entryWith({})],
  readerOverride?: MediaBackend['reader'],
): Promise<Rig> {
  const reader = new FakeReader()
  const db = await openWebDb({ factory: new IDBFactory() })
  await db.device.put({
    deviceId: 'web-device-1',
    wrappedMasterHex: 'ab'.repeat(WRAPPED_MASTER_HEX_LEN / 2),
    kekSaltHex: 'cd'.repeat(16),
    recoveryGeneration: 3,
    masterFingerprint: 'fp',
    name: 'web',
  })
  let unlocked = true
  let loaded = entries
  let leaked: VaultEntry[] = []
  const vault = {
    listLoaded: () => [...loaded, ...leaked],
    getEntry: (id: string) => {
      const found = loaded.find((e) => e.metadata.entry_id === id)
      if (found === undefined) throw new EntryUnavailableError(id, 'locked')
      return found
    },
  } as unknown as VaultApi
  const limit = createLimiter(4)
  const limitedRuns = { count: 0 }
  const opens = { count: 0 }
  const media: MediaBackend = {
    db,
    reader: readerOverride ?? (reader as unknown as MediaBackend['reader']),
    core: {
      openMedia: (ring, bytes) => {
        opens.count += 1
        return fakeCore.openMedia(ring, bytes)
      },
    },
    limit: (task) => {
      limitedRuns.count += 1
      return limit(task)
    },
  }
  configureReadEnv({
    isUnlocked: () => unlocked,
    session: async () => ({
      vault,
      media,
      ready: async () => EMPTY_TAXONOMY,
      acquireOutboxLock: async () => () => undefined,
      pull: async () => ({ stale: [], changed: false }),
    }),
  })
  const clock = { now: 1000 }
  configureMediaEnv({
    now: () => clock.now,
    keyRing: () => ({}) as KeyRing,
  })
  return {
    reader,
    db,
    limitedRuns,
    opens,
    clock,
    setUnlocked: (v) => {
      unlocked = v
    },
    setLoaded: (e) => {
      loaded = e
    },
    setLeaked: (e) => {
      leaked = e
    },
  }
}

const call = <T>(name: string, mediaId: string): Promise<T> =>
  Promise.resolve(mediaHandlers[name]({ mediaId })) as Promise<T>

afterEach(() => {
  configureReadEnv({})
  configureMediaEnv({})
})

describe('locked vault', () => {
  it('rejects every handler with VaultLockedError and makes no request', async () => {
    const r = await rig()
    r.setUnlocked(false)
    for (const name of Object.keys(mediaHandlers)) {
      await expect(call(name, MID), name).rejects.toBeInstanceOf(VaultLockedError)
    }
    expect(r.reader.calls).toEqual([])
  })
})

describe('get_media_status', () => {
  it('reports the media available from the synced metadata without any request', async () => {
    const r = await rig()
    const status = await call<Record<string, unknown>>('get_media_status', MID)
    expect(status).toEqual({
      mediaId: MID,
      cachedLocally: true,
      hasCloudCopy: true,
      localPath: `memlore-web://media/${MID}`,
      thumbnailPath: `memlore-web://media/${MID}.thumb`,
      fileType: 'image/png',
      fileSize: 10,
      compressed: false,
      width: 4,
      height: 3,
    })
    expect(r.reader.calls).toEqual([])
  })

  it('has no thumbnail for a document and rejects an unknown id', async () => {
    await rig([entryWith({ fileType: 'application/pdf' })])
    const status = await call<{ thumbnailPath: string | null }>('get_media_status', MID)
    expect(status.thumbnailPath).toBeNull()
    await expect(call('get_media_status', 'nope')).rejects.toBeInstanceOf(MediaNotFoundError)
  })
})

describe('resolution', () => {
  it('serves the thumbnail without touching the full media', async () => {
    const r = await rig()
    r.reader.files.set(`${OWNER}/media/${MID}.thumb`, seal(THUMB_PLAIN))
    r.reader.files.set(`${OWNER}/media/${MID}`, seal(PLAIN))
    const bytes = await call<number[]>('read_media_thumbnail_bytes', MID)
    expect(Uint8Array.from(bytes)).toEqual(THUMB_PLAIN)
    expect(r.reader.calls).toEqual([`3:${OWNER}/media/${MID}.thumb`])
  })

  it('downloads the full media only when asked, accepting envelope 0x01 too', async () => {
    const r = await rig()
    r.reader.files.set(`${OWNER}/media/${MID}`, seal(PLAIN, 0x01))
    const bytes = await call<number[]>('read_media_bytes', MID)
    expect(Uint8Array.from(bytes)).toEqual(PLAIN)
    expect(r.reader.calls).toEqual([`3:${OWNER}/media/${MID}`])
  })

  it('routes media read to outbox/m-<id> when present', async () => {
    const r = await rig([entryWith({ isOutbox: true })])
    r.reader.files.set(`${OWNER}/outbox/m-${MID}`, seal(PLAIN))
    const bytes = await call<number[]>('read_media_bytes', MID)
    expect(Uint8Array.from(bytes)).toEqual(PLAIN)
    expect(r.reader.calls).toEqual([`3:${OWNER}/outbox/m-${MID}`])
  })

  it("reads web media on a synced entry from the uploading browser's outbox first", async () => {
    // A desktop-owned entry (device_id = OWNER) overlaid with media another browser (OTHER) added.
    const r = await rig([entryWith({ isOutbox: true, outboxDevice: OTHER })])
    r.reader.files.set(`${OTHER}/outbox/m-${MID}`, seal(PLAIN))
    const bytes = await call<number[]>('read_media_bytes', MID)
    expect(Uint8Array.from(bytes)).toEqual(PLAIN)
    expect(r.reader.calls[0]).toBe(`3:${OTHER}/outbox/m-${MID}`)
  })

  it('falls back to the full media when no thumbnail exists', async () => {
    const r = await rig()
    r.reader.files.set(`${OWNER}/media/${MID}`, seal(PLAIN))
    const bytes = await call<number[]>('read_media_thumbnail_bytes', MID)
    expect(Uint8Array.from(bytes)).toEqual(PLAIN)
    expect(r.reader.calls).toEqual([`3:${OWNER}/media/${MID}.thumb`, `3:${OWNER}/media/${MID}`])
  })

  it('serves a cache hit without Drive and touches lastAccess', async () => {
    const r = await rig()
    r.reader.files.set(`${OWNER}/media/${MID}`, seal(PLAIN))
    await call('read_media_bytes', MID)
    expect((await r.db.blobs.get(`media/${MID}`))?.lastAccess).toBe(1000)
    r.reader.calls.length = 0
    r.clock.now = 1000 + TOUCH_INTERVAL_MS
    expect(Uint8Array.from(await call<number[]>('read_media_bytes', MID))).toEqual(PLAIN)
    expect(r.reader.calls).toEqual([])
    expect((await r.db.blobs.get(`media/${MID}`))?.lastAccess).toBe(1000 + TOUCH_INTERVAL_MS)
  })

  it('does not rewrite a cached blob for a hit within the hour', async () => {
    const r = await rig()
    r.reader.files.set(`${OWNER}/media/${MID}`, seal(PLAIN))
    await call('read_media_bytes', MID)
    const put = vi.spyOn(r.db.blobs, 'put')
    const touch = vi.spyOn(r.db.blobs, 'touch')
    r.clock.now = 1000 + TOUCH_INTERVAL_MS - 1
    await call('read_media_bytes', MID)
    expect(put).not.toHaveBeenCalled()
    expect(touch).not.toHaveBeenCalled()
    expect((await r.db.blobs.get(`media/${MID}`))?.lastAccess).toBe(1000)
    r.clock.now = 1000 + TOUCH_INTERVAL_MS
    await call('read_media_bytes', MID)
    expect(touch).toHaveBeenCalledOnce()
  })

  it('decrypts once per read, from the cache or from Drive', async () => {
    const r = await rig()
    r.reader.files.set(`${OWNER}/media/${MID}`, seal(PLAIN))
    await call('read_media_bytes', MID)
    expect(r.opens.count).toBe(1)
    await call('resolve_media', MID) // cache hit
    expect(r.opens.count).toBe(2)
  })

  it('stores only the ciphertext, under a key distinct from the thumbnail', async () => {
    const r = await rig()
    const sealed = seal(PLAIN)
    r.reader.files.set(`${OWNER}/media/${MID}`, sealed)
    r.reader.files.set(`${OWNER}/media/${MID}.thumb`, seal(THUMB_PLAIN))
    await call('resolve_media', MID)
    await call('resolve_media_thumbnail', MID)
    const full = await r.db.blobs.get(`media/${MID}`)
    expect(full?.bytes).toEqual(sealed)
    expect(full?.size).toBe(sealed.length)
    expect(new TextDecoder('latin1').decode(full?.bytes)).not.toContain('PLAINTEXT-MARKER')
    expect((await r.db.blobs.get(`media/${MID}.thumb`))?.bytes).toEqual(seal(THUMB_PLAIN))
  })

  it('resolve_media returns a synthetic path', async () => {
    const r = await rig()
    r.reader.files.set(`${OWNER}/media/${MID}`, seal(PLAIN))
    expect(await call('resolve_media', MID)).toBe(`memlore-web://media/${MID}`)
  })

  it("falls back to another known device's folder when the owner has no copy", async () => {
    const r = await rig()
    const put = (path: string) =>
      r.db.files.put({
        path,
        ciphertext: new Uint8Array([1]),
        etag: null,
        modifiedTime: null,
        lastAccess: 1,
        pinned: false,
      })
    await put(`${OTHER}/metadata.json`)
    await put(`${OWNER}/metadata.json`)
    await put('not-a-device/entries/x.bin')
    r.reader.files.set(`${OTHER}/media/${MID}`, seal(PLAIN))
    expect(Uint8Array.from(await call<number[]>('read_media_bytes', MID))).toEqual(PLAIN)
    expect(r.reader.calls).toEqual([`3:${OWNER}/media/${MID}`, `3:${OTHER}/media/${MID}`])
  })

  it('coalesces two simultaneous reads into one download under the limiter', async () => {
    const r = await rig()
    r.reader.files.set(`${OWNER}/media/${MID}`, seal(PLAIN))
    let release: () => void = () => undefined
    r.reader.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const a = call<number[]>('read_media_bytes', MID)
    const b = call<number[]>('read_media_bytes', MID)
    await new Promise((resolve) => setTimeout(resolve, 10))
    release()
    expect(Uint8Array.from(await a)).toEqual(PLAIN)
    expect(Uint8Array.from(await b)).toEqual(PLAIN)
    expect(r.reader.calls).toHaveLength(1)
    expect(r.limitedRuns.count).toBe(1)
  })

  it('resolves a media unknown to the metadata from the pending hook only', async () => {
    const r = await rig()
    const other = 'ffffffff-1111-4222-8333-bbbbbbbbbbbb'
    await expect(call('read_media_bytes', other)).rejects.toBeInstanceOf(MediaNotFoundError)
    configureMediaEnv({
      keyRing: () => ({}) as KeyRing,
      pendingMediaResolver: async (id, thumb) => (id === other && !thumb ? seal(PLAIN) : null),
    })
    expect(Uint8Array.from(await call<number[]>('read_media_bytes', other))).toEqual(PLAIN)
    await expect(call('read_media_thumbnail_bytes', other)).rejects.toBeInstanceOf(
      MediaNotFoundError,
    )
    expect(r.reader.calls).toEqual([])
  })
})

describe('size cap', () => {
  it('rejects a media over 200 MB with too_large_for_web and makes zero requests', async () => {
    const r = await rig([entryWith({ fileType: 'video/mp4', fileSize: MAX_WEB_MEDIA_BYTES + 1 })])
    const error = await call('read_media_bytes', MID).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TooLargeForWebError)
    expect((error as TooLargeForWebError).code).toBe('too_large_for_web')
    expect((error as Error).message).toContain('too_large_for_web')
    await expect(call('resolve_media', MID)).rejects.toBeInstanceOf(TooLargeForWebError)
    expect(r.reader.calls).toEqual([])
  })

  it('serves a media of exactly 200 MB and any size without metadata (resolve)', async () => {
    const r = await rig([entryWith({ fileSize: MAX_WEB_MEDIA_BYTES })])
    r.reader.files.set(`${OWNER}/media/${MID}`, seal(PLAIN))
    await call('resolve_media', MID)
    r.setLoaded([entryWith({ fileSize: null })])
    await call('resolve_media', MID)
  })

  it('read_media_bytes (number[] transport) stops at 32 MiB with too_large_for_web', async () => {
    const r = await rig([entryWith({ fileSize: TOO_LARGE_FOR_NUMBER_ARRAY + 1 })])
    await expect(call('read_media_bytes', MID)).rejects.toBeInstanceOf(TooLargeForWebError)
    expect(r.reader.calls).toEqual([])
    r.setLoaded([entryWith({ fileSize: TOO_LARGE_FOR_NUMBER_ARRAY })])
    r.reader.files.set(`${OWNER}/media/${MID}`, seal(PLAIN))
    await call('read_media_bytes', MID)
    expect(r.reader.caps[0]).toBe(TOO_LARGE_FOR_NUMBER_ARRAY + ENVELOPE_OVERHEAD_BYTES)
    // resolve keeps the 200 MB cap
    r.setLoaded([entryWith({ fileSize: TOO_LARGE_FOR_NUMBER_ARRAY + 1 })])
    await call('resolve_media', MID)
  })

  it('caps the download at the metadata size (plus overhead) or 200 MB when it is unknown', async () => {
    const r = await rig([entryWith({ fileSize: 1000 })])
    r.reader.files.set(`${OWNER}/media/${MID}`, seal(PLAIN))
    await call('resolve_media', MID)
    expect(r.reader.caps).toEqual([1000 + ENVELOPE_OVERHEAD_BYTES])
    for (const fileSize of [null, Number.NaN]) {
      r.reader.caps.length = 0
      await r.db.blobs.delete(`media/${MID}`)
      r.setLoaded([entryWith({ fileSize })])
      await call('resolve_media', MID)
      expect(r.reader.caps).toEqual([MAX_WEB_MEDIA_BYTES + ENVELOPE_OVERHEAD_BYTES])
    }
  })

  it('treats file_size 0, negative or NaN as unknown: cap is 200 MB + overhead and the file is served', async () => {
    const r = await rig([entryWith({ fileSize: 0 })])
    r.reader.files.set(`${OWNER}/media/${MID}`, seal(PLAIN))
    for (const fileSize of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      r.reader.caps.length = 0
      await r.db.blobs.delete(`media/${MID}`)
      r.setLoaded([entryWith({ fileSize })])
      await call('resolve_media', MID)
      expect(r.reader.caps).toEqual([MAX_WEB_MEDIA_BYTES + ENVELOPE_OVERHEAD_BYTES])
      expect(await r.db.blobs.get(`media/${MID}`)).toBeDefined()
    }
  })

  it('a genuinely oversize declared size is too_large_for_web, not a mismatch, with no request', async () => {
    const r = await rig([entryWith({ fileSize: MAX_WEB_MEDIA_BYTES + 1 })])
    const error = await call('resolve_media', MID).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TooLargeForWebError)
    expect((error as TooLargeForWebError).code).toBe('too_large_for_web')
    expect(r.reader.calls).toEqual([])
  })

  it('an understated file_size has a distinct media_size_mismatch error', async () => {
    expect(new MediaSizeMismatchError().code).toBe('media_size_mismatch')
    expect(new MediaSizeMismatchError()).not.toBeInstanceOf(TooLargeForWebError)
  })

  it('fails closed on an understated file_size: the larger body is refused and not stored', async () => {
    const r = await rig([entryWith({ fileSize: 1 })])
    r.reader.files.set(`${OWNER}/media/${MID}`, seal(new Uint8Array(500)))
    await expect(call('resolve_media', MID)).rejects.toBeInstanceOf(MediaSizeMismatchError)
    expect(await r.db.blobs.get(`media/${MID}`)).toBeUndefined()
    // the same body at the limit passes
    r.setLoaded([entryWith({ fileSize: 500 })])
    await call('resolve_media', MID)
  })

  it('a size mismatch on the owner device falls through to a good copy on another device', async () => {
    const r = await rig([entryWith({ fileSize: 10 })])
    await r.db.files.put({
      path: `${OTHER}/metadata.json`,
      ciphertext: new Uint8Array(2),
      etag: null,
      modifiedTime: null,
      lastAccess: 1,
      pinned: false,
    })
    r.reader.files.set(`${OWNER}/media/${MID}`, seal(new Uint8Array(500))) // stale, too big
    r.reader.files.set(`${OTHER}/media/${MID}`, seal(PLAIN))
    expect(Uint8Array.from(await call<number[]>('read_media_bytes', MID))).toEqual(PLAIN)
    expect(r.reader.calls.map((c) => c.split(':')[1])).toEqual([
      `${OWNER}/media/${MID}`,
      `${OTHER}/media/${MID}`,
    ])
    // every candidate mismatching still fails closed with the mismatch error
    await r.db.blobs.delete(`media/${MID}`)
    r.reader.files.set(`${OTHER}/media/${MID}`, seal(new Uint8Array(500)))
    await expect(call('resolve_media', MID)).rejects.toBeInstanceOf(MediaSizeMismatchError)
    expect(await r.db.blobs.get(`media/${MID}`)).toBeUndefined()
  })

  it('caps a .thumb at 16 MB: an oversize one is not stored and the full file is used', async () => {
    const r = await rig()
    r.reader.files.set(`${OWNER}/media/${MID}.thumb`, new Uint8Array(MAX_THUMB_BYTES + 1000))
    r.reader.files.set(`${OWNER}/media/${MID}`, seal(PLAIN))
    expect(Uint8Array.from(await call<number[]>('read_media_thumbnail_bytes', MID))).toEqual(PLAIN)
    expect(r.reader.caps).toEqual([
      MAX_THUMB_BYTES + ENVELOPE_OVERHEAD_BYTES,
      10 + ENVELOPE_OVERHEAD_BYTES,
    ])
    expect(await r.db.blobs.get(`media/${MID}.thumb`)).toBeUndefined()
  })

  it('never caps a genuine thumbnail of a huge video', async () => {
    const r = await rig([entryWith({ fileType: 'video/mp4', fileSize: MAX_WEB_MEDIA_BYTES * 2 })])
    r.reader.files.set(`${OWNER}/media/${MID}.thumb`, seal(THUMB_PLAIN))
    expect(Uint8Array.from(await call<number[]>('read_media_thumbnail_bytes', MID))).toEqual(
      THUMB_PLAIN,
    )
  })

  describe('with the real reader (streamed bodies)', () => {
    async function realRig(fileSize: number | null): Promise<{ r: Rig; drive: FakeDrive }> {
      const drive = new FakeDrive()
      const folder = drive.chain('Memlore', 'generations', 'g-3', OWNER, 'media')
      drive.addFile(MID, folder, 'x')
      drive.addFile(`${MID}.thumb`, folder, 'x')
      const reader = new DriveReader({ getToken: async () => 'tok', fetchImpl: drive.fetch })
      const r = await rig([entryWith({ fileSize })], reader)
      return { r, drive }
    }

    const endless = (declared?: number): { response: Response; state: { pulls: number } } => {
      const state = { pulls: 0 }
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          state.pulls += 1
          if (state.pulls > 1000) controller.close() // a runaway read ends instead of hanging
          controller.enqueue(new Uint8Array(1000))
        },
      })
      const headers: Record<string, string> =
        declared === undefined ? {} : { 'content-length': String(declared) }
      return { response: new Response(stream, { headers }), state }
    }

    const serveBody = (drive: FakeDrive, response: Response): void => {
      drive.interceptors.push((req) =>
        req.url.searchParams.get('alt') === 'media' ? response : undefined,
      )
    }

    it('refuses a huge Content-Length with null file_size: no body read, nothing stored', async () => {
      const { r, drive } = await realRig(null)
      const { response, state } = endless(10 * MAX_WEB_MEDIA_BYTES)
      serveBody(drive, response)
      await expect(call('resolve_media', MID)).rejects.toBeInstanceOf(TooLargeForWebError)
      expect(state.pulls).toBeLessThanOrEqual(1)
      expect(await r.db.blobs.get(`media/${MID}`)).toBeUndefined()
    })

    it('aborts a chunked body at an understated file_size', async () => {
      const { r, drive } = await realRig(100)
      const { response, state } = endless()
      serveBody(drive, response)
      await expect(call('resolve_media', MID)).rejects.toBeInstanceOf(MediaSizeMismatchError)
      expect(state.pulls).toBeLessThanOrEqual(3) // 164 bytes allowed, 1000 per chunk
      expect(await r.db.blobs.get(`media/${MID}`)).toBeUndefined()
    })

    it('does not buffer an oversize .thumb and falls back to the full file', async () => {
      const { r, drive } = await realRig(10)
      const { response, state } = endless(MAX_THUMB_BYTES * 4)
      const thumb = drive.files.find((f) => f.name === `${MID}.thumb`)
      const full = drive.files.find((f) => f.name === MID)
      if (thumb === undefined || full === undefined) throw new Error('fixture')
      full.content = seal(PLAIN)
      drive.interceptors.push((req) =>
        req.url.pathname.endsWith(`/${thumb.id}`) && req.url.searchParams.get('alt') === 'media'
          ? response
          : undefined,
      )
      expect(Uint8Array.from(await call<number[]>('read_media_thumbnail_bytes', MID))).toEqual(
        PLAIN,
      )
      expect(state.pulls).toBeLessThanOrEqual(1)
      expect(await r.db.blobs.get(`media/${MID}.thumb`)).toBeUndefined()
    })
  })
})

describe('errors', () => {
  it('rejects tampered ciphertext with a typed error and does not cache it', async () => {
    const r = await rig()
    r.reader.files.set(`${OWNER}/media/${MID}`, Uint8Array.from([0xff, 1, 2, 3]))
    const error = await call('read_media_bytes', MID).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MediaCorruptError)
    expect((error as Error).message).not.toContain('255')
    expect(await r.db.blobs.get(`media/${MID}`)).toBeUndefined()
  })

  it('drops a damaged cached copy and downloads again', async () => {
    const r = await rig()
    await r.db.blobs.put({
      path: `media/${MID}`,
      bytes: Uint8Array.from([0xff, 9]),
      size: 2,
      lastAccess: 1,
    })
    r.reader.files.set(`${OWNER}/media/${MID}`, seal(PLAIN))
    expect(Uint8Array.from(await call<number[]>('read_media_bytes', MID))).toEqual(PLAIN)
    expect((await r.db.blobs.get(`media/${MID}`))?.bytes).toEqual(seal(PLAIN))
  })

  it('falls back to the full file when the thumbnail is corrupt, dropping the cached thumb', async () => {
    const r = await rig()
    await r.db.blobs.put({
      path: `media/${MID}.thumb`,
      bytes: Uint8Array.from([0xff, 9]),
      size: 2,
      lastAccess: 1,
    })
    r.reader.files.set(`${OWNER}/media/${MID}.thumb`, Uint8Array.from([0xff, 1, 2]))
    r.reader.files.set(`${OWNER}/media/${MID}`, seal(PLAIN))
    expect(Uint8Array.from(await call<number[]>('read_media_thumbnail_bytes', MID))).toEqual(PLAIN)
    expect(await r.db.blobs.get(`media/${MID}.thumb`)).toBeUndefined()
  })

  it('maps a Drive failure to a retryable error without poisoning the cache', async () => {
    const r = await rig()
    r.reader.files.set(`${OWNER}/media/${MID}`, seal(PLAIN))
    r.reader.failWith = new DriveHttpError(503)
    const error = await call('read_media_bytes', MID).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MediaTransientError)
    expect((error as MediaTransientError).retryable).toBe(true)
    expect(await r.db.blobs.get(`media/${MID}`)).toBeUndefined()
    r.reader.failWith = null
    expect(Uint8Array.from(await call<number[]>('read_media_bytes', MID))).toEqual(PLAIN)
  })

  it('reports a media missing everywhere as not found', async () => {
    await rig()
    await expect(call('read_media_bytes', MID)).rejects.toBeInstanceOf(MediaNotFoundError)
  })
})

describe('media of entries the web does not serve', () => {
  it('rejects the media of a locked entry although the bytes exist, without a request', async () => {
    const r = await rig([])
    r.setLeaked([entryWith({ entryId: 'locked-entry' })])
    r.reader.files.set(`${OWNER}/media/${MID}`, seal(PLAIN))
    for (const name of Object.keys(mediaHandlers)) {
      await expect(call(name, MID), name).rejects.toBeInstanceOf(MediaNotFoundError)
    }
    expect(r.reader.calls).toEqual([])
  })

  it('does not serve a media that is not loaded (stubs carry no media)', async () => {
    const r = await rig([])
    r.reader.files.set(`${OWNER}/media/${MID}`, seal(PLAIN))
    await expect(call('read_media_bytes', MID)).rejects.toBeInstanceOf(MediaNotFoundError)
    expect(r.reader.calls).toEqual([])
  })

  it('does not serve a media tombstoned by deleted_media (created_at <= deleted_at)', async () => {
    const r = await rig([entryWith({}, { deleted_media: [{ id: MID, deleted_at: 9 }] })])
    r.reader.files.set(`${OWNER}/media/${MID}`, seal(PLAIN))
    await expect(call('read_media_bytes', MID)).rejects.toBeInstanceOf(MediaNotFoundError)
    // A media re-added after the tombstone stays live.
    r.setLoaded([entryWith({ createdAt: 10 }, { deleted_media: [{ id: MID, deleted_at: 9 }] })])
    await call('read_media_bytes', MID)
  })

  it('stores and returns nothing when the vault locks during a download', async () => {
    const r = await rig()
    r.reader.files.set(`${OWNER}/media/${MID}`, seal(PLAIN))
    let release: () => void = () => undefined
    r.reader.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = call('read_media_bytes', MID)
    await new Promise((resolve) => setTimeout(resolve, 10))
    r.setUnlocked(false)
    release()
    await expect(pending).rejects.toBeInstanceOf(VaultLockedError)
    expect(await r.db.blobs.get(`media/${MID}`)).toBeUndefined()
  })

  it('drops the result when the entry is locked while the download is in flight', async () => {
    const r = await rig()
    r.reader.files.set(`${OWNER}/media/${MID}`, seal(PLAIN))
    let release: () => void = () => undefined
    r.reader.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = call('read_media_bytes', MID)
    await new Promise((resolve) => setTimeout(resolve, 10))
    r.setLoaded([])
    release()
    await expect(pending).rejects.toBeInstanceOf(MediaNotFoundError)
  })
})

describe('untrusted names', () => {
  const bad = ['', '..', '.hidden', 'a/b', '__proto__', 'x y', 'a'.repeat(300)]

  it.each(bad)('treats the media id %j as missing without any request', async (id) => {
    const r = await rig([entryWith({ id })])
    await expect(call('read_media_bytes', id)).rejects.toBeInstanceOf(MediaNotFoundError)
    await expect(call('get_media_status', id)).rejects.toBeInstanceOf(MediaNotFoundError)
    expect(r.reader.calls).toEqual([])
  })

  it.each(['..', 'a/b', '.meta', 'gen erations', 'generations'])(
    'treats the owning device %j as missing without any request',
    async (device) => {
      const r = await rig([entryWith({ device })])
      await expect(call('read_media_bytes', MID)).rejects.toBeInstanceOf(MediaNotFoundError)
      expect(r.reader.calls).toEqual([])
    },
  )

  it('ignores a non-string media id argument', async () => {
    await rig()
    await expect(mediaHandlers.read_media_bytes({ mediaId: 42 })).rejects.toBeInstanceOf(
      MediaNotFoundError,
    )
  })
})
