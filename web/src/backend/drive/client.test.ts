import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as clientModule from './client'
import {
  API,
  FOLDER,
  FakeDrive,
  bytes,
  fakeLocks,
  json,
  seedVault,
  text,
  violations,
  type FakeFile,
} from './fakeDrive'
import {
  DriveAuthError,
  DriveConflictError,
  DriveHttpError,
  DriveNotFoundError,
  DriveProtocolError,
  DriveReader,
  DriveTooLargeError,
  DriveWriter,
  DEFAULT_MAX_DOWNLOAD_BYTES,
  ForbiddenWriteError,
  LockUnavailableError,
  VaultNotReadyError,
  type DriveWriterDeps,
  type EnsureFolderResult,
  type PutResult,
} from './client'

// ---------------------------------------------------------------------------------------------
// The in-memory fake Drive and its global safety guard live in ./fakeDrive.
// ---------------------------------------------------------------------------------------------

const OWN = '11111111-2222-4333-8444-555555555555'
const PEER = '99999999-8888-4777-8666-555555555555'
const UUID_A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const UUID_B = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee'

interface Harness {
  drive: FakeDrive
  reader: DriveReader
  writer: DriveWriter
  sleeps: number[]
  locks: ReturnType<typeof fakeLocks>
}

function makeHarness(
  opts: { gen?: number; identity?: boolean; locks?: DriveWriterDeps['locks'] } = {},
): Harness {
  const drive = new FakeDrive()
  const sleeps: number[] = []
  const locks = fakeLocks(drive)
  const deps: DriveWriterDeps = {
    getToken: async () => 'tok',
    fetchImpl: drive.fetch,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    locks: opts.locks === undefined ? locks : opts.locks,
  }
  const reader = new DriveReader(deps)
  const writer = new DriveWriter(reader, deps)
  if (opts.identity !== false) writer.setIdentity({ ownId: OWN, localGen: opts.gen ?? 0 })
  return { drive, reader, writer, sleeps, locks }
}

const outbox = (gen = 0, own = OWN): string => `generations/g-${gen}/${own}/outbox`

beforeEach(() => {
  violations.length = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
  expect(violations).toEqual([])
})

// ---------------------------------------------------------------------------------------------

describe('write allowlist (zero network on refusal)', () => {
  const forbidden: Array<[string, string]> = [
    ['control.json', '.meta/control.json'],
    ['keyring _meta.json', '.meta/keyring/_meta.json'],
    ['_content.json', '.meta/keyring/_content.json'],
    ['_recovery.json', '.meta/keyring/_recovery.json'],
    ['_recovery_marker.json', '.meta/_recovery_marker.json'],
    ['peer outbox', `generations/g-0/${PEER}/outbox/${UUID_A}.bin`],
    ['peer device folder metadata', `generations/g-0/${PEER}/metadata.json`],
    ['another generation', `generations/g-1/${OWN}/outbox/${UUID_A}.bin`],
    ['flat outbox at generation 0', `${OWN}/outbox/${UUID_A}.bin`],
    ['flat entries at generation 0', `${OWN}/entries/${UUID_A}.bin`],
    ['metadata.json', `generations/g-0/${OWN}/metadata.json`],
    ['entries/', `generations/g-0/${OWN}/entries/x.bin`],
    ['entries/ with uuid', `generations/g-0/${OWN}/entries/${UUID_A}.bin`],
    ['media/', `generations/g-0/${OWN}/media/x`],
    ['journals/', `generations/g-0/${OWN}/journals/${UUID_A}.bin`],
    ['device-root bin', `generations/g-0/${OWN}/tags.bin`],
    ['outbox-acks.bin', `generations/g-0/${OWN}/outbox-acks.bin`],
    ['nested outbox/media', `generations/g-0/${OWN}/outbox/media/x`],
    ['nested outbox uuid', `generations/g-0/${OWN}/outbox/sub/${UUID_A}.bin`],
    ['outbox non-uuid', `generations/g-0/${OWN}/outbox/x.bin`],
    ['outbox uuid wrong ext', `generations/g-0/${OWN}/outbox/${UUID_A}.txt`],
    ['outbox media thumb thumb', `generations/g-0/${OWN}/outbox/m-${UUID_A}.thumb.thumb`],
    ['uppercase uuid', `generations/g-0/${OWN}/outbox/${UUID_A.toUpperCase()}.bin`],
    ['trailing slash', `generations/g-0/${OWN}/outbox/${UUID_A}.bin/`],
    ['trailing newline', `generations/g-0/${OWN}/outbox/${UUID_A}.bin\n`],
    ['leading slash', `/generations/g-0/${OWN}/outbox/${UUID_A}.bin`],
    ['double slash', `generations/g-0/${OWN}//outbox/${UUID_A}.bin`],
    ['empty own segment', `generations/g-0//outbox/${UUID_A}.bin`],
    ['traversal', `generations/g-0/${OWN}/outbox/../metadata.json`],
    ['traversal to control', `generations/g-0/${OWN}/outbox/../../../.meta/control.json`],
    ['leading traversal', `../${OWN}/outbox/${UUID_A}.bin`],
    ['url-encoded traversal', `generations/g-0/${OWN}/outbox/%2e%2e/metadata.json`],
    ['url-encoded slash', `generations/g-0/${OWN}%2foutbox/${UUID_A}.bin`],
    ['backslashes', `generations\\g-0\\${OWN}\\outbox\\${UUID_A}.bin`],
    ['NUL suffix', `generations/g-0/${OWN}/outbox/${UUID_A}.bin\u0000`],
    ['NUL inside', `generations/g-0/${OWN}/outbox/${UUID_A}\u0000.bin`],
    ['cyrillic lookalike', `generations/g-0/${OWN}/outbоx/${UUID_A}.bin`],
    ['fullwidth solidus', `generations/g-0/${OWN}／outbox/${UUID_A}.bin`],
    ['other device slot', `.meta/keyring/devices/${PEER}.json`],
    ['own slot .bak', `.meta/keyring/devices/${OWN}.json.bak`],
    ['own slot nested', `.meta/keyring/devices/${OWN}.json/x`],
    ['own slot in other folder', `.meta/keyring/${OWN}.json`],
    ['devices folder itself', '.meta/keyring/devices/'],
    ['empty path', ''],
  ]

  it.each(forbidden)('refuses %s with no fetch', async (_label, path) => {
    const { drive, writer } = makeHarness()
    seedVault(drive)
    drive.requests.length = 0
    await expect(writer.put(path, bytes('x'))).rejects.toBeInstanceOf(ForbiddenWriteError)
    expect(drive.requests).toHaveLength(0)
  })

  it('refuses everything when the identity is not set', async () => {
    const { drive, writer } = makeHarness({ identity: false })
    await expect(writer.put(`${outbox()}/${UUID_A}.bin`, bytes('x'))).rejects.toBeInstanceOf(
      ForbiddenWriteError,
    )
    await expect(writer.ensureFolder()).rejects.toBeInstanceOf(ForbiddenWriteError)
    expect(drive.requests).toHaveLength(0)
  })

  it('refuses another generation and the generation-0 namespace when localGen is 3', async () => {
    const { drive, writer } = makeHarness({ gen: 3 })
    for (const path of [
      `generations/g-0/${OWN}/outbox/${UUID_A}.bin`,
      `generations/g-33/${OWN}/outbox/${UUID_A}.bin`,
      `generations/g-03/${OWN}/outbox/${UUID_A}.bin`,
      `${OWN}/outbox/${UUID_A}.bin`,
    ]) {
      await expect(writer.put(path, bytes('x'))).rejects.toBeInstanceOf(ForbiddenWriteError)
    }
    expect(drive.requests).toHaveLength(0)
  })

  it('allows exactly the own slot and the flat own outbox, including generation 0', async () => {
    const { drive, writer } = makeHarness()
    const { genRoot } = seedVault(drive)
    const devices = drive.find(['Memlore', '.meta', 'keyring', 'devices'])?.id as string
    await writer.ensureFolder()
    expect(genRoot).not.toBeNull()
    for (const path of [
      `.meta/keyring/devices/${OWN}.json`,
      `${outbox()}/${UUID_A}.bin`,
      `${outbox()}/m-${UUID_B}`,
      `${outbox()}/m-${UUID_B}.thumb`,
    ]) {
      const result = await writer.put(path, bytes('payload'))
      expect(result.created).toBe(true)
    }
    expect(drive.files.some((f) => f.name === `${OWN}.json` && f.parents[0] === devices)).toBe(true)
  })

  it('setIdentity is one-time and validates the device id', () => {
    const { writer } = makeHarness()
    expect(() => writer.setIdentity({ ownId: OWN, localGen: 0 })).not.toThrow()
    expect(() => writer.setIdentity({ ownId: PEER, localGen: 0 })).toThrow(ForbiddenWriteError)
    expect(() => writer.setIdentity({ ownId: OWN, localGen: 1 })).toThrow(ForbiddenWriteError)
    const fresh = makeHarness({ identity: false }).writer
    for (const bad of [
      '',
      '../x',
      'a/b',
      'abc',
      '........',
      '-1234567-',
      OWN + '.json',
      'a'.repeat(65),
      '1234567g',
    ]) {
      expect(() => fresh.setIdentity({ ownId: bad, localGen: 0 }), JSON.stringify(bad)).toThrow(
        ForbiddenWriteError,
      )
    }
    expect(() => fresh.setIdentity({ ownId: OWN, localGen: -1 })).toThrow(ForbiddenWriteError)
    expect(() => fresh.setIdentity({ ownId: OWN, localGen: 1.5 })).toThrow(ForbiddenWriteError)
  })
})

describe('shared ancestors are never created', () => {
  const levels = [
    'Memlore',
    '.meta',
    '.meta/keyring',
    '.meta/keyring/devices',
    'generations',
    'g-0',
  ]

  it.each(levels)(
    'ensureFolder throws VaultNotReadyError when %s is missing, with no create',
    async (missing) => {
      const { drive, writer } = makeHarness()
      seedVault(drive, 0, missing)
      await expect(writer.ensureFolder()).rejects.toBeInstanceOf(VaultNotReadyError)
      expect(drive.mutating()).toHaveLength(0)
    },
  )

  it('put refuses with VaultNotReadyError when the slot parent folders are missing', async () => {
    const { drive, writer } = makeHarness()
    seedVault(drive, 0, '.meta/keyring/devices')
    await expect(
      writer.put(`.meta/keyring/devices/${OWN}.json`, bytes('{}')),
    ).rejects.toBeInstanceOf(VaultNotReadyError)
    expect(drive.mutating()).toHaveLength(0)
  })

  it('put refuses with VaultNotReadyError before ensureFolder created the outbox', async () => {
    const { drive, writer } = makeHarness()
    seedVault(drive)
    await expect(writer.put(`${outbox()}/${UUID_A}.bin`, bytes('x'))).rejects.toBeInstanceOf(
      VaultNotReadyError,
    )
    expect(drive.mutating()).toHaveLength(0)
  })

  it('creates only <ownId> and <ownId>/outbox under g-N, with exact bodies, and is idempotent', async () => {
    const { drive, writer } = makeHarness({ gen: 2 })
    const { genRoot } = seedVault(drive, 2)
    const result = await writer.ensureFolder()

    const posts = drive.mutating()
    expect(posts.map((r) => r.method)).toEqual(['POST', 'POST'])
    expect(posts.map((r) => r.url.pathname)).toEqual(['/drive/v3/files', '/drive/v3/files'])
    const bodies = posts.map((r) => JSON.parse(text(r.body as Uint8Array)))
    const deviceFolder = drive.find(['Memlore', 'generations', 'g-2', OWN]) as FakeFile
    expect(bodies).toEqual([
      { name: OWN, mimeType: FOLDER, parents: [genRoot] },
      { name: 'outbox', mimeType: FOLDER, parents: [deviceFolder.id] },
    ])
    expect(result.deviceFolderId).toBe(deviceFolder.id)

    drive.requests.length = 0
    await expect(writer.ensureFolder()).resolves.toEqual(result)
    expect(drive.mutating()).toHaveLength(0)
  })
})

describe('duplicate names', () => {
  it('picks the earliest createdTime, then the smallest id', async () => {
    const { drive, reader } = makeHarness()
    drive.add('Memlore', 'appDataFolder', { id: 'late', createdTime: '2026-03-01T00:00:00.000Z' })
    drive.add('Memlore', 'appDataFolder', {
      id: 'early-b',
      createdTime: '2026-01-01T00:00:00.000Z',
    })
    drive.add('Memlore', 'appDataFolder', {
      id: 'early-a',
      createdTime: '2026-01-01T00:00:00.000Z',
    })
    expect(await reader.findRootId()).toBe('early-a')
  })

  it('sorts by time even when the server order is wrong, and never touches the others', async () => {
    const { drive, reader } = makeHarness()
    drive.interceptors.push((req) =>
      req.url.pathname === '/drive/v3/files'
        ? json({
            files: [
              { id: 'z', name: 'Memlore', createdTime: '2026-05-01T00:00:00.000Z' },
              { id: 'a', name: 'Memlore', createdTime: '2026-02-01T00:00:00.000Z' },
            ],
          })
        : undefined,
    )
    expect(await reader.findRootId()).toBe('a')
    expect(drive.mutating()).toHaveLength(0)
  })

  it('fails closed when duplicates carry no createdTime', async () => {
    const { drive, reader } = makeHarness()
    drive.interceptors.push(() =>
      json({
        files: [
          { id: 'a', name: 'Memlore' },
          { id: 'b', name: 'Memlore' },
        ],
      }),
    )
    await expect(reader.findRootId()).rejects.toBeInstanceOf(DriveProtocolError)
  })

  it('updates the earliest duplicate file in place', async () => {
    const { drive, writer } = makeHarness()
    seedVault(drive)
    await writer.ensureFolder()
    const parent = (drive.find(['Memlore', 'generations', 'g-0', OWN, 'outbox']) as FakeFile).id
    drive.addFile(`${UUID_A}.bin`, parent, 'new', {
      id: 'f-late',
      createdTime: '2026-06-01T00:00:00.000Z',
    })
    drive.addFile(`${UUID_A}.bin`, parent, 'old', {
      id: 'f-early',
      createdTime: '2026-01-01T00:00:00.000Z',
    })
    const result = await writer.put(`${outbox()}/${UUID_A}.bin`, bytes('fresh'))
    expect(result).toEqual({ fileId: 'f-early', created: false, adoptedOther: false })
    expect(text(drive.files.find((f) => f.id === 'f-early')?.content as Uint8Array)).toBe('fresh')
    expect(text(drive.files.find((f) => f.id === 'f-late')?.content as Uint8Array)).toBe('new')
  })
})

describe('put: update in place, create only when absent', () => {
  async function readyOutbox(): Promise<Harness & { parent: string }> {
    const h = makeHarness()
    seedVault(h.drive)
    await h.writer.ensureFolder()
    const parent = (h.drive.find(['Memlore', 'generations', 'g-0', OWN, 'outbox']) as FakeFile).id
    h.drive.requests.length = 0
    return { ...h, parent }
  }

  it('updates an existing file with If-Match and never creates', async () => {
    const h = await readyOutbox()
    const id = h.drive.addFile(`${UUID_A}.bin`, h.parent, 'old')
    const result = await h.writer.put(`${outbox()}/${UUID_A}.bin`, bytes('new'))
    expect(result).toEqual({ fileId: id, created: false, adoptedOther: false })
    const writes = h.drive.mutating()
    expect(writes).toHaveLength(1)
    expect(writes[0].method).toBe('PATCH')
    expect(writes[0].url.pathname).toBe(`/upload/drive/v3/files/${id}`)
    expect(writes[0].headers.get('if-match')).toBe(`"etag-${id}-1"`)
    expect(text(h.drive.files.find((f) => f.id === id)?.content as Uint8Array)).toBe('new')
    expect(h.drive.files.filter((f) => f.name === `${UUID_A}.bin`)).toHaveLength(1)
  })

  it('updates an existing .json slot in place as a media upload (no unsafe-PATCH violation)', async () => {
    const h = makeHarness()
    seedVault(h.drive)
    const devices = (h.drive.find(['Memlore', '.meta', 'keyring', 'devices']) as FakeFile).id
    const id = h.drive.addFile(`${OWN}.json`, devices, '{"old":1}')
    const result = await h.writer.put(`.meta/keyring/devices/${OWN}.json`, bytes('{"name":"x"}'))
    expect(result).toEqual({ fileId: id, created: false, adoptedOther: false })
    const writes = h.drive.mutating()
    expect(writes).toHaveLength(1)
    expect(writes[0].method).toBe('PATCH')
    expect(writes[0].headers.get('content-type')).toBe('application/json')
    expect(writes[0].url.searchParams.get('uploadType')).toBe('media')
    expect(text(h.drive.files.find((f) => f.id === id)?.content as Uint8Array)).toBe('{"name":"x"}')
    expect(violations).toEqual([])
  })

  it('creates via multipart when absent and reports a normal create', async () => {
    const h = await readyOutbox()
    const result = await h.writer.put(
      `${outbox()}/m-${UUID_B}`,
      new Uint8Array([0, 255, 13, 10, 7]),
    )
    expect(result.created).toBe(true)
    expect(result.adoptedOther).toBe(false)
    const post = h.drive.mutating()[0]
    expect(post.url.pathname).toBe('/upload/drive/v3/files')
    expect(post.url.searchParams.get('uploadType')).toBe('multipart')
    expect(post.headers.get('content-type')).toMatch(
      /^multipart\/related; boundary=memlore_[0-9a-f]{32}$/,
    )
    const stored = h.drive.files.find((f) => f.id === result.fileId) as FakeFile
    expect(stored.name).toBe(`m-${UUID_B}`)
    expect(stored.parents).toEqual([h.parent])
    expect(Array.from(stored.content)).toEqual([0, 255, 13, 10, 7])
  })

  it('adopts the earliest file after a create race and never deletes ours', async () => {
    const h = await readyOutbox()
    h.drive.interceptors.push((req) => {
      // A competing file with an earlier createdTime appears right after our create.
      if (req.method === 'POST' && req.url.pathname === '/upload/drive/v3/files') {
        h.drive.interceptors.length = 0
        h.drive.addFile(`${UUID_A}.bin`, h.parent, 'theirs', {
          id: 'older',
          createdTime: '2000-01-01T00:00:00.000Z',
        })
      }
      return undefined
    })
    const result = await h.writer.put(`${outbox()}/${UUID_A}.bin`, bytes('mine'))
    expect(result.created).toBe(true)
    expect(result.adoptedOther).toBe(true)
    expect(result.fileId).toBe('older')
    expect(h.drive.files.filter((f) => f.name === `${UUID_A}.bin`)).toHaveLength(2)
    expect(h.drive.mutating().map((r) => r.method)).toEqual(['POST'])
  })

  it('returns the created id when the re-list does not show it yet (eventual consistency)', async () => {
    const h = await readyOutbox()
    h.drive.interceptors.push((req) =>
      req.method === 'GET' &&
      req.url.pathname === '/drive/v3/files' &&
      h.drive.mutating().length > 0
        ? json({ files: [] })
        : undefined,
    )
    const result = await h.writer.put(`${outbox()}/${UUID_A}.bin`, bytes('x'))
    const stored = h.drive.files.find((f) => f.name === `${UUID_A}.bin`) as FakeFile
    expect(result).toEqual({ fileId: stored.id, created: true, adoptedOther: false })
    expect(h.drive.mutating().map((r) => r.method)).toEqual(['POST'])
  })

  it('adopts the earliest listed file when the re-list shows a competitor but not ours', async () => {
    const h = await readyOutbox()
    h.drive.interceptors.push((req) =>
      req.method === 'GET' &&
      req.url.pathname === '/drive/v3/files' &&
      h.drive.mutating().length > 0
        ? json({
            files: [
              { id: 'older', name: `${UUID_A}.bin`, createdTime: '2000-01-01T00:00:00.000Z' },
            ],
          })
        : undefined,
    )
    const result = await h.writer.put(`${outbox()}/${UUID_A}.bin`, bytes('mine'))
    const ours = h.drive.files.find((f) => f.name === `${UUID_A}.bin`) as FakeFile
    expect(ours.id).not.toBe('older')
    expect(result).toEqual({ fileId: 'older', created: true, adoptedOther: true })
    expect(h.drive.mutating().map((r) => r.method)).toEqual(['POST'])
  })

  it('fails closed without an ETag: no PATCH is sent', async () => {
    const h = await readyOutbox()
    h.drive.addFile(`${UUID_A}.bin`, h.parent, 'old')
    h.drive.omitEtag = true
    await expect(h.writer.put(`${outbox()}/${UUID_A}.bin`, bytes('new'))).rejects.toBeInstanceOf(
      DriveProtocolError,
    )
    expect(h.drive.mutating()).toHaveLength(0)
  })

  it('surfaces a typed conflict on 412 and does not retry or overwrite', async () => {
    const h = await readyOutbox()
    const id = h.drive.addFile(`${UUID_A}.bin`, h.parent, 'old')
    h.drive.interceptors.push((req) =>
      req.method === 'PATCH' ? json({ error: 'pre' }, 412) : undefined,
    )
    await expect(h.writer.put(`${outbox()}/${UUID_A}.bin`, bytes('new'))).rejects.toBeInstanceOf(
      DriveConflictError,
    )
    expect(h.drive.mutating()).toHaveLength(1)
    expect(text(h.drive.files.find((f) => f.id === id)?.content as Uint8Array)).toBe('old')
  })

  it('maps a stale ETag (file changed between GET and PATCH) to a conflict', async () => {
    const h = await readyOutbox()
    const id = h.drive.addFile(`${UUID_A}.bin`, h.parent, 'old')
    h.drive.interceptors.push((req) => {
      if (req.method === 'PATCH') (h.drive.files.find((f) => f.id === id) as FakeFile).version += 1
      return undefined
    })
    await expect(h.writer.put(`${outbox()}/${UUID_A}.bin`, bytes('new'))).rejects.toBeInstanceOf(
      DriveConflictError,
    )
  })

  it('uses a JSON content type for the device slot', async () => {
    const h = makeHarness()
    seedVault(h.drive)
    const result = await h.writer.put(`.meta/keyring/devices/${OWN}.json`, bytes('{"a":1}'))
    expect(result.created).toBe(true)
    expect(text(h.drive.files.find((f) => f.id === result.fileId)?.content as Uint8Array)).toBe(
      '{"a":1}',
    )
    expect(text(h.drive.mutating()[0].body as Uint8Array)).toContain(
      'Content-Type: application/json\r\n\r\n{"a":1}',
    )
  })
})

describe('single writer lock', () => {
  it('serializes two concurrent puts', async () => {
    const h = makeHarness()
    seedVault(h.drive)
    await h.writer.ensureFolder()
    h.locks.events.length = 0
    const base = h.drive.requests.length
    await Promise.all([
      h.writer.put(`${outbox()}/${UUID_A}.bin`, bytes('a')),
      h.writer.put(`${outbox()}/${UUID_B}.bin`, bytes('b')),
    ])
    expect(h.locks.maxActive).toBe(1)
    const marks = h.locks.events.map((e) => ({
      kind: e.split('@')[0],
      at: Number(e.split('@')[1]),
    }))
    expect(marks.map((m) => m.kind)).toEqual(['enter', 'exit', 'enter', 'exit'])
    // The second put issued no request before the first one released the lock.
    expect(marks[0].at).toBe(base)
    expect(marks[2].at).toBe(marks[1].at)
    expect(marks[1].at).toBeGreaterThan(marks[0].at)
    expect(h.drive.requests.length).toBeGreaterThan(marks[1].at)
  })

  it('a put started while ensureFolder holds the lock acquires it again and never overlaps', async () => {
    const h = makeHarness()
    seedVault(h.drive)
    const started: Array<Promise<PutResult>> = []
    // Fires on ensureFolder's first request, i.e. while it holds the lock.
    h.drive.interceptors.push(() => {
      if (started.length === 0) started.push(h.writer.put(`${outbox()}/${UUID_A}.bin`, bytes('a')))
      return undefined
    })
    await h.writer.ensureFolder()
    const [put] = await Promise.allSettled(started)
    expect(put.status).toBe('fulfilled')
    expect(h.locks.maxActive).toBe(1)
    expect(h.locks.events.map((e) => e.split('@')[0])).toEqual(['enter', 'exit', 'enter', 'exit'])
  })

  it('an ensureFolder started while a put holds the lock acquires it again', async () => {
    const h = makeHarness()
    seedVault(h.drive)
    await h.writer.ensureFolder()
    h.locks.events.length = 0
    const started: Array<Promise<EnsureFolderResult>> = []
    h.drive.interceptors.push(() => {
      if (started.length === 0) started.push(h.writer.ensureFolder())
      return undefined
    })
    await h.writer.put(`${outbox()}/${UUID_A}.bin`, bytes('a'))
    await Promise.all(started)
    expect(h.locks.maxActive).toBe(1)
    expect(h.locks.events.map((e) => e.split('@')[0])).toEqual(['enter', 'exit', 'enter', 'exit'])
  })

  it('the lock-scoped handle writes without re-acquiring the lock', async () => {
    const h = makeHarness()
    seedVault(h.drive)
    const result = await h.writer.withLock(async (handle) => {
      await handle.ensureFolder()
      return handle.put(`${outbox()}/${UUID_A}.bin`, bytes('a'))
    })
    expect(result.created).toBe(true)
    expect(h.locks.events.filter((e) => e.startsWith('enter'))).toHaveLength(1)
  })

  it('the lock-scoped handle keeps the allowlist (zero network on refusal)', async () => {
    const h = makeHarness()
    seedVault(h.drive)
    h.drive.requests.length = 0
    await expect(
      h.writer.withLock((handle) => handle.put('.meta/control.json', bytes('x'))),
    ).rejects.toBeInstanceOf(ForbiddenWriteError)
    expect(h.drive.requests).toHaveLength(0)
  })

  it('the lock-scoped handle refuses use after the lock is released', async () => {
    const h = makeHarness()
    seedVault(h.drive)
    const handle = await h.writer.withLock(async (lockHandle) => lockHandle)
    h.drive.requests.length = 0
    await expect(handle.put(`${outbox()}/${UUID_A}.bin`, bytes('x'))).rejects.toBeInstanceOf(
      LockUnavailableError,
    )
    await expect(handle.ensureFolder()).rejects.toBeInstanceOf(LockUnavailableError)
    expect(h.drive.requests).toHaveLength(0)
  })

  it('ensureFolder also takes the lock', async () => {
    const h = makeHarness()
    seedVault(h.drive)
    await h.writer.ensureFolder()
    expect(h.locks.events.filter((e) => e.startsWith('enter'))).toHaveLength(1)
  })

  it('fails closed with no lock manager (explicit null)', async () => {
    const h = makeHarness({ locks: null })
    seedVault(h.drive)
    h.drive.requests.length = 0
    await expect(h.writer.put(`${outbox()}/${UUID_A}.bin`, bytes('x'))).rejects.toBeInstanceOf(
      LockUnavailableError,
    )
    await expect(h.writer.ensureFolder()).rejects.toBeInstanceOf(LockUnavailableError)
    expect(h.drive.requests).toHaveLength(0)
  })

  it('fails closed when navigator.locks is unavailable in the environment', async () => {
    vi.stubGlobal('navigator', {})
    const drive = new FakeDrive()
    const deps: DriveWriterDeps = { getToken: async () => 'tok', fetchImpl: drive.fetch }
    const reader = new DriveReader(deps)
    const writer = new DriveWriter(reader, deps)
    writer.setIdentity({ ownId: OWN, localGen: 0 })
    await expect(writer.put(`${outbox()}/${UUID_A}.bin`, bytes('x'))).rejects.toBeInstanceOf(
      LockUnavailableError,
    )
    expect(drive.requests).toHaveLength(0)
  })
})

describe('retries and error mapping', () => {
  it('retries 503 with 400/800/1600 ms backoff and then succeeds', async () => {
    const h = makeHarness()
    let calls = 0
    h.drive.interceptors.push(() => (++calls <= 3 ? json({ error: 'x' }, 503) : undefined))
    expect(await h.reader.findRootId()).toBeNull()
    expect(calls).toBe(4)
    expect(h.sleeps).toEqual([400, 800, 1600])
  })

  it('gives up after 4 attempts and surfaces the status', async () => {
    const h = makeHarness()
    h.drive.interceptors.push(() => json({ error: 'x' }, 500))
    const error = await h.reader.findRootId().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DriveHttpError)
    expect((error as DriveHttpError).status).toBe(500)
    expect(h.drive.requests).toHaveLength(4)
    expect(h.sleeps).toHaveLength(3)
  })

  it('retries 429 and honours Retry-After, capped at 10 s', async () => {
    const h = makeHarness()
    const waits = ['2', '99']
    let calls = 0
    h.drive.interceptors.push(() => {
      calls += 1
      const wait = waits.shift()
      return wait === undefined ? undefined : json({ error: 'rl' }, 429, { 'Retry-After': wait })
    })
    await h.reader.findRootId()
    expect(calls).toBe(3)
    expect(h.sleeps).toEqual([2_000, 10_000])
  })

  it('does not retry 401 and surfaces an auth error', async () => {
    const h = makeHarness()
    h.drive.interceptors.push(() => json({ error: 'auth' }, 401))
    await expect(h.reader.findRootId()).rejects.toBeInstanceOf(DriveAuthError)
    expect(h.drive.requests).toHaveLength(1)
    expect(h.sleeps).toHaveLength(0)
  })

  it('does not retry a write after a 5xx (a create could duplicate)', async () => {
    const h = makeHarness()
    seedVault(h.drive)
    await h.writer.ensureFolder()
    h.drive.requests.length = 0
    h.drive.interceptors.push((req) =>
      req.method === 'POST' ? json({ error: 'x' }, 503) : undefined,
    )
    await expect(h.writer.put(`${outbox()}/${UUID_A}.bin`, bytes('x'))).rejects.toBeInstanceOf(
      DriveHttpError,
    )
    expect(h.drive.mutating()).toHaveLength(1)
  })

  it('retries a write on 429 (the request was not processed)', async () => {
    const h = makeHarness()
    seedVault(h.drive)
    await h.writer.ensureFolder()
    let first = true
    h.drive.interceptors.push((req) => {
      if (req.method === 'POST' && first) {
        first = false
        return json({ error: 'rl' }, 429)
      }
      return undefined
    })
    const result = await h.writer.put(`${outbox()}/${UUID_A}.bin`, bytes('x'))
    expect(result.created).toBe(true)
    expect(h.sleeps).toEqual([400])
  })

  it('maps a transport failure to a DriveHttpError with status 0', async () => {
    const reader = new DriveReader({
      getToken: async () => 'tok',
      fetchImpl: async () => {
        throw new TypeError('offline')
      },
    })
    const error = await reader.findRootId().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DriveHttpError)
    expect((error as DriveHttpError).status).toBe(0)
  })

  it('fails closed on malformed responses', async () => {
    const h = makeHarness()
    h.drive.interceptors.push(() => json({ nope: true }))
    await expect(h.reader.findRootId()).rejects.toBeInstanceOf(DriveProtocolError)
    h.drive.interceptors.length = 0
    h.drive.interceptors.push(() => json({ files: [{ name: 'Memlore' }] }))
    await expect(h.reader.findRootId()).rejects.toBeInstanceOf(DriveProtocolError)
  })

  it('fails closed when a create answers without an id: nothing else is written', async () => {
    const h = makeHarness()
    seedVault(h.drive)
    h.drive.interceptors.push((req) => (req.method === 'POST' ? json({}) : undefined))
    await expect(h.writer.ensureFolder()).rejects.toBeInstanceOf(DriveProtocolError)
    expect(h.drive.mutating()).toHaveLength(1)
  })
})

describe('reader: paging, alt=media, bearer', () => {
  it('follows nextPageToken and downloads with alt=media', async () => {
    const h = makeHarness()
    const folder = h.drive.chain('Memlore', 'stuff')
    h.drive.pageSize = 2
    for (let i = 0; i < 5; i++) h.drive.addFile(`f${i}`, folder, `c${i}`)
    h.drive.requests.length = 0
    const files = await h.reader.listFolder(folder, 'files')
    expect(files.map((f) => f.name)).toEqual(['f0', 'f1', 'f2', 'f3', 'f4'])
    expect(h.drive.requests).toHaveLength(3)
    expect(h.drive.requests[1].url.searchParams.get('pageToken')).toBe('2')
    expect(
      h.drive.requests.every((r) => r.url.searchParams.get('spaces') === 'appDataFolder'),
    ).toBe(true)

    const data = await h.reader.getFile(files[3].id)
    expect(text(data)).toBe('c3')
    const last = h.drive.requests[h.drive.requests.length - 1]
    expect(last.url.searchParams.get('alt')).toBe('media')
    expect(last.url.href.startsWith(`${API}/drive/v3/files/`)).toBe(true)
  })

  describe('getFile byte cap', () => {
    const readerFor = (respond: () => Response): DriveReader =>
      new DriveReader({ getToken: async () => 'tok', fetchImpl: async () => respond() })

    /** An endless body that counts its pulls, with a declared length when given. */
    function endless(contentLength?: number): { response: Response; state: { pulls: number } } {
      const state = { pulls: 0 }
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          state.pulls += 1
          if (state.pulls > 1000) controller.close() // a runaway read ends instead of hanging
          controller.enqueue(new Uint8Array(10))
        },
      })
      const headers: Record<string, string> =
        contentLength === undefined ? {} : { 'content-length': String(contentLength) }
      return { response: new Response(stream, { headers }), state }
    }

    it('refuses a declared Content-Length over the cap without reading the body', async () => {
      const { response, state } = endless(1_000_000)
      await expect(readerFor(() => response).getFile('abc', 100)).rejects.toBeInstanceOf(
        DriveTooLargeError,
      )
      expect(state.pulls).toBeLessThanOrEqual(1) // the stream's initial fill only
    })

    it('cancels a chunked body the moment it exceeds the cap', async () => {
      const { response, state } = endless()
      await expect(readerFor(() => response).getFile('abc', 100)).rejects.toBeInstanceOf(
        DriveTooLargeError,
      )
      // Far below the helper's 1000-pull runaway cap: the stream was cancelled, not drained. The
      // exact count depends on the runtime's ReadableStream read-ahead, so it is not pinned.
      expect(state.pulls).toBeGreaterThan(0)
      expect(state.pulls).toBeLessThan(200)
    })

    it('preallocates from a valid Content-Length and returns an exact-length view', async () => {
      const body = new Uint8Array(100).map((_, i) => i)
      const out = await readerFor(
        () => new Response(body, { headers: { 'content-length': '100' } }),
      ).getFile('abc', 1000)
      expect(out).toEqual(body)
      expect(out.byteLength).toBe(100)
    })

    it('handles a body shorter or longer than its Content-Length, bounded by the cap', async () => {
      const body = new Uint8Array(100).map((_, i) => i)
      const header = (n: number): Record<string, string> => ({ 'content-length': String(n) })
      const shorter = await readerFor(() => new Response(body, { headers: header(150) })).getFile(
        'abc',
        1000,
      )
      expect(shorter).toEqual(body) // exact received length, not the declared one
      expect(shorter.byteLength).toBe(100)
      const chunked = (): Response =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(body.subarray(0, 60))
              controller.enqueue(body.subarray(60))
              controller.close()
            },
          }),
          { headers: header(40) },
        )
      const longer = await readerFor(chunked).getFile('abc', 1000)
      expect(longer).toEqual(body)
      await expect(readerFor(chunked).getFile('abc', 90)).rejects.toBeInstanceOf(DriveTooLargeError)
    })

    it('always returns a buffer of exactly the body length (no hidden zero tail)', async () => {
      const body = new Uint8Array(100).map((_, i) => i + 1)
      const header = (n: number): Record<string, string> => ({ 'content-length': String(n) })
      const exact = (out: Uint8Array): void => {
        expect(out.byteOffset).toBe(0)
        expect(out.buffer.byteLength).toBe(out.length)
      }
      const shorter = await readerFor(() => new Response(body, { headers: header(150) })).getFile(
        'abc',
        1000,
      )
      exact(shorter)
      expect(shorter.length).toBe(100)
      const same = await readerFor(() => new Response(body, { headers: header(100) })).getFile(
        'abc',
        1000,
      )
      exact(same)
      const chunks = (): Response =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(body.subarray(0, 60))
              controller.enqueue(body.subarray(60))
              controller.close()
            },
          }),
          { headers: header(40) },
        )
      const longer = await readerFor(chunks).getFile('abc', 1000)
      exact(longer)
      expect(longer).toEqual(body)
      const empty = await readerFor(
        () => new Response(new Uint8Array(0), { headers: header(50) }),
      ).getFile('abc', 1000)
      expect(empty.buffer.byteLength).toBe(0)
    })

    it('grows past the preallocation cap for an honest large body', async () => {
      const size = 9 * 1024 * 1024
      const body = new Uint8Array(size).fill(3)
      const out = await readerFor(
        () => new Response(body, { headers: { 'content-length': String(size) } }),
      ).getFile('abc', 20 * 1024 * 1024)
      expect(out.length).toBe(size)
      expect(out.buffer.byteLength).toBe(size)
      expect(out[size - 1]).toBe(3)
    })

    it('serves a body of exactly the cap and uses 64 MiB when no cap is given', async () => {
      const body = new Uint8Array(100).fill(7)
      expect(await readerFor(() => new Response(body)).getFile('abc', 100)).toEqual(body)
      expect(DEFAULT_MAX_DOWNLOAD_BYTES).toBe(64 * 1024 * 1024)
      const { response } = endless(DEFAULT_MAX_DOWNLOAD_BYTES + 1)
      await expect(readerFor(() => response).getFile('abc')).rejects.toBeInstanceOf(
        DriveTooLargeError,
      )
    })
  })

  it('takes the bearer token from the injected provider on every attempt', async () => {
    const tokens = ['t1', 't2']
    const seen: string[] = []
    const reader = new DriveReader({
      getToken: async () => tokens.shift() ?? 'tN',
      fetchImpl: async (_url, init) => {
        seen.push(new Headers(init?.headers).get('authorization') ?? '')
        return seen.length === 1 ? json({}, 503) : json({ files: [] })
      },
      sleep: async () => undefined,
    })
    await reader.findRootId()
    expect(seen).toEqual(['Bearer t1', 'Bearer t2'])
  })

  it('escapes quotes and backslashes in queries', async () => {
    const h = makeHarness()
    await h.reader.findFolder("o'brien\\x", 'appDataFolder')
    expect(h.drive.requests[0].url.searchParams.get('q')).toContain("name = 'o\\'brien\\\\x'")
  })

  it('refuses unsafe resolvePath input and unlisted shared reads', async () => {
    const { reader } = makeHarness()
    await expect(reader.resolvePath('../x')).rejects.toBeInstanceOf(RangeError)
    await expect(reader.resolvePath("a'b/c")).rejects.toBeInstanceOf(RangeError)
    await expect(reader.readSharedFile('.meta/keyring.json')).rejects.toBeInstanceOf(RangeError)
  })

  it('resolves and reads shared files', async () => {
    const h = makeHarness()
    const keyring = h.drive.chain('Memlore', '.meta')
    h.drive.addFile('control.json', keyring, '{"g":0}')
    expect(text(await h.reader.readSharedFile('.meta/control.json'))).toBe('{"g":0}')
    await expect(h.reader.readSharedFile('.meta/_recovery_marker.json')).rejects.toBeInstanceOf(
      DriveNotFoundError,
    )
  })
})

describe('reader: desktop namespace rules', () => {
  it('lists devices from the generation folder plus the flat root, filtering reserved names', async () => {
    const h = makeHarness()
    const { genRoot } = seedVault(h.drive)
    const root = h.drive.find(['Memlore'])?.id as string
    h.drive.add('gen-dev1', genRoot as string)
    h.drive.add('flat-dev1', root)
    h.drive.add('both-dev', genRoot as string)
    h.drive.add('both-dev', root)
    h.drive.add('ab', root)
    h.drive.add('bad name', root)
    expect(await h.reader.listDevices(0)).toEqual(['both-dev', 'flat-dev1', 'gen-dev1'])
  })

  it('lists only flat devices when there is no generation folder, and none without a root', async () => {
    const h = makeHarness()
    expect(await h.reader.listDevices(0)).toEqual([])
    const root = h.drive.chain('Memlore')
    h.drive.add('flat-dev1', root)
    h.drive.add('generations', root)
    expect(await h.reader.listDevices(0)).toEqual(['flat-dev1'])
  })

  it('device-root listing reads only the generation folder', async () => {
    const h = makeHarness()
    const { genRoot } = seedVault(h.drive)
    const root = h.drive.find(['Memlore'])?.id as string
    const flat = h.drive.add('dev-aaaa', root)
    h.drive.addFile('tags.bin', flat, 'flat')
    expect(await h.reader.listDeviceFiles(0, 'dev-aaaa', null)).toEqual([])
    const gen = h.drive.add('dev-aaaa', genRoot as string)
    h.drive.addFile('settings.bin', gen, 'gen')
    h.drive.add('folder-not-file', gen)
    expect(await h.reader.listDeviceFiles(0, 'dev-aaaa', null)).toEqual(['settings.bin'])
  })

  it('channel listing merges generation and flat, and an empty generation slot does not hide flat', async () => {
    const h = makeHarness()
    const { genRoot } = seedVault(h.drive)
    const root = h.drive.find(['Memlore'])?.id as string
    const gen = h.drive.add('dev-aaaa', genRoot as string)
    const flat = h.drive.add('dev-aaaa', root)
    const flatEntries = h.drive.add('entries', flat)
    h.drive.addFile('e1.bin', flatEntries, 'flat1')
    h.drive.addFile('e2.bin', flatEntries, 'flat2')
    expect(await h.reader.listDeviceFiles(0, 'dev-aaaa', 'entries')).toEqual(['e1.bin', 'e2.bin'])
    const genEntries = h.drive.add('entries', gen)
    h.drive.addFile('e2.bin', genEntries, 'gen2')
    h.drive.addFile('e3.bin', genEntries, 'gen3')
    expect(await h.reader.listDeviceFiles(0, 'dev-aaaa', 'entries')).toEqual([
      'e1.bin',
      'e2.bin',
      'e3.bin',
    ])
  })

  it('readDeviceFile tries the generation folder first, then flat', async () => {
    const h = makeHarness()
    const { genRoot } = seedVault(h.drive)
    const root = h.drive.find(['Memlore'])?.id as string
    const gen = h.drive.add('dev-aaaa', genRoot as string)
    const flat = h.drive.add('dev-aaaa', root)
    const genEntries = h.drive.add('entries', gen)
    const flatEntries = h.drive.add('entries', flat)
    h.drive.addFile('both.bin', genEntries, 'from-gen')
    h.drive.addFile('both.bin', flatEntries, 'from-flat')
    h.drive.addFile('flat-only.bin', flatEntries, 'only-flat')
    h.drive.addFile('metadata.json', flat, '{"flat":true}')
    expect(text(await h.reader.readDeviceFile(0, 'dev-aaaa/entries/both.bin'))).toBe('from-gen')
    expect(text(await h.reader.readDeviceFile(0, 'dev-aaaa/entries/flat-only.bin'))).toBe(
      'only-flat',
    )
    expect(text(await h.reader.readDeviceFile(0, 'dev-aaaa/metadata.json'))).toBe('{"flat":true}')
    await expect(h.reader.readDeviceFile(0, 'dev-aaaa/entries/none.bin')).rejects.toBeInstanceOf(
      DriveNotFoundError,
    )
    await expect(h.reader.readDeviceFile(0, 'dev-aaaa/entries/../x')).rejects.toBeInstanceOf(
      RangeError,
    )
    await expect(h.reader.readDeviceFile(0, 'dev-aaaa')).rejects.toBeInstanceOf(RangeError)
  })

  it('readDeviceFile uses the flat folder when there is no generation folder', async () => {
    const h = makeHarness()
    const root = h.drive.chain('Memlore')
    const flat = h.drive.add('dev-aaaa', root)
    h.drive.addFile('metadata.json', flat, '{}')
    expect(text(await h.reader.readDeviceFile(5, 'dev-aaaa/metadata.json'))).toBe('{}')
  })
})

describe('no delete / trash / remove anywhere', () => {
  function namesOf(target: object): string[] {
    const names = new Set<string>()
    for (let o: object | null = target; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      for (const name of Reflect.ownKeys(o)) names.add(String(name))
    }
    return [...names]
  }

  it('has no such method on reader, writer, their prototypes or the module exports', () => {
    const { reader, writer } = makeHarness()
    const all = [
      ...namesOf(reader),
      ...namesOf(writer),
      ...namesOf(DriveReader),
      ...namesOf(DriveWriter),
      ...Object.keys(clientModule),
    ]
    expect(all.length).toBeGreaterThan(10)
    expect(all.filter((name) => /delete|trash|remove/i.test(name))).toEqual([])
  })

  it('the whole put/ensureFolder flow only issues GET, POST and PATCH (global guard)', async () => {
    const h = makeHarness()
    seedVault(h.drive)
    await h.writer.ensureFolder()
    await h.writer.put(`${outbox()}/${UUID_A}.bin`, bytes('1'))
    await h.writer.put(`${outbox()}/${UUID_A}.bin`, bytes('2'))
    expect(new Set(h.drive.requests.map((r) => r.method))).toEqual(
      new Set(['GET', 'POST', 'PATCH']),
    )
  })
})
