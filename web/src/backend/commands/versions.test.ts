import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VersionMeta } from '../../../../src/lib/tauri'
import type { Core } from '../../core/core'
import { configureKeysEnv, dispose, lock, setKeyRing, type KeyRing } from '../keys'
import type { IndexEntry } from '../sync/entryIndex'
import { getFormatGuardReason, resetFormatGuardLatch } from '../sync/formatGuard'
import { createMonthIndexReader } from '../sync/monthIndex'
import { configureReadEnv, type MediaBackend } from './readSession'
import { EMPTY_TAXONOMY, FakeVault, type FakeSpec } from './readTestKit'
import { versionHandlers } from './versions'

const SRC = 'aaaaaaaa-0000-4000-8000-000000000001'
const PEER = 'cccccccc-0000-4000-8000-000000000003'
const ENTRY_DATE = Date.UTC(2026, 2, 5, 12) / 1000
const encoder = new TextEncoder()
const enc = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value))

interface VersionSpec {
  id: string
  device?: string
  createdAt: number
}

interface Rig {
  vault: FakeVault
  index: Map<string, IndexEntry>
  /** Logical paths read from Drive (versions only). */
  driveReads: string[]
  /** Version files on Drive: path to `{entryId, versionId}` the fake core opens them as. */
  files: Map<string, { entryId: string; versionId: string; yjs: number[] }>
  /** Runs inside the next Drive read, before it resolves. */
  duringRead: { hook: (() => void) | null }
}

function rig(versions: VersionSpec[], specs: FakeSpec[]): Rig {
  const index = new Map<string, IndexEntry>([
    ['e1', { entryId: 'e1', authorDevice: SRC, updatedAt: 100, isDeleted: false }],
  ])
  const month = new Date(ENTRY_DATE * 1000).toISOString().slice(0, 7)
  const row = {
    entry_id: 'e1',
    updated_at: 100,
    entry_date: ENTRY_DATE,
    journal_id: 'j1',
    emotion: null,
    is_favorite: false,
    tag_ids: [],
    word_count: 0,
    title: null,
    preview_text: null,
    latitude: null,
    longitude: null,
    location_label: null,
    media: [],
    versions: versions.map((v) => ({
      version_id: v.id,
      device_id: v.device ?? SRC,
      created_at: v.createdAt,
    })),
  }
  const remote = new Map<string, Uint8Array>([
    [
      `${SRC}/index/months.bin`,
      enc({
        schema_version: 1,
        device_id: SRC,
        generated_at: 1,
        months: [{ month, hash_hex: 'h' }],
      }),
    ],
    [
      `${SRC}/index/${month}.bin`,
      enc({ schema_version: 1, device_id: SRC, month, generated_at: 1, rows: [row] }),
    ],
  ])
  const monthIndex = createMonthIndexReader({
    puller: {
      indexSource: SRC,
      pulls: 1,
      get index() {
        return index
      },
      readDeviceBin: async (path) => remote.get(path) ?? null,
    },
    db: {
      files: {
        get: async () => undefined,
        put: async () => undefined,
        delete: async () => undefined,
        paths: async () => [],
      },
    },
    core: { openDeviceBin: (_ring, bytes) => bytes },
    isJournalExcluded: () => false,
    getKeyRing: () => ({}) as KeyRing,
  })
  const files = new Map<string, { entryId: string; versionId: string; yjs: number[] }>()
  const driveReads: string[] = []
  const duringRead: Rig['duringRead'] = { hook: null }
  const media = {
    db: { device: { get: async () => ({ recoveryGeneration: 2 }) } },
    reader: {
      readDeviceFile: async (generation: number, path: string) => {
        expect(generation).toBe(2)
        driveReads.push(path)
        const hook = duringRead.hook
        duringRead.hook = null
        hook?.()
        const file = files.get(path)
        if (file === undefined) {
          const missing = new Error(path)
          missing.name = 'DriveNotFoundError'
          throw missing
        }
        // XJV1 envelope bytes (never an XJS1 payload).
        return enc({ magic: 'XJV1', path })
      },
    },
    limit: <T>(task: () => Promise<T>) => task(),
  } as unknown as MediaBackend
  const core = {
    openVersion: (_ring: KeyRing, bytes: Uint8Array) => {
      const { path } = JSON.parse(new TextDecoder().decode(bytes)) as { path: string }
      const file = files.get(path)!
      return {
        metadataJson: JSON.stringify({
          version_id: file.versionId,
          entry_id: file.entryId,
          created_at: 1,
          device_id: SRC,
          preview_text: 'p',
        }),
        yjs: new Uint8Array(file.yjs),
        free: () => undefined,
      }
    },
  } as unknown as Core
  const vault = new FakeVault(specs)
  configureReadEnv({
    session: async () => ({
      vault,
      monthIndex,
      media,
      core,
      ready: async () => EMPTY_TAXONOMY,
      acquireOutboxLock: async () => () => undefined,
      pull: async () => ({ stale: [], changed: false }),
    }),
  })
  return { vault, index, driveReads, files, duringRead }
}

const VISIBLE: FakeSpec = { id: 'e1', updatedAt: 100, entryDate: ENTRY_DATE }

const list = (entryId = 'e1') =>
  Promise.resolve(versionHandlers.list_entry_versions({ entryId, activeVaultId: null })) as Promise<
    VersionMeta[]
  >

const content = (versionId: string, entryId = 'e1') =>
  Promise.resolve(
    versionHandlers.get_entry_version_content({ versionId, entryId, activeVaultId: null }),
  ) as Promise<number[]>

beforeEach(() => {
  configureKeysEnv({ emit: () => undefined, document: null, window: null })
  setKeyRing({ lock: () => undefined, isLocked: () => false } as unknown as KeyRing)
  resetFormatGuardLatch()
})

afterEach(() => {
  configureReadEnv({})
  dispose()
  resetFormatGuardLatch()
})

describe('list_entry_versions', () => {
  it('lists the index row versions newest first with safe ids only, no file read', async () => {
    const r = rig(
      [
        { id: 'v-old', createdAt: 10 },
        { id: 'v-new', device: PEER, createdAt: 30 },
        { id: 'v-tie-b', createdAt: 20 },
        { id: 'v-tie-a', createdAt: 20 },
        { id: '../escape', createdAt: 40 },
        { id: '.hidden', createdAt: 40 },
        { id: 'v-bad-device', device: '../x', createdAt: 40 },
      ],
      [VISIBLE],
    )
    expect(await list()).toEqual([
      { id: 'v-new', createdAt: 30, previewText: '', deviceId: PEER },
      { id: 'v-tie-b', createdAt: 20, previewText: '', deviceId: SRC },
      { id: 'v-tie-a', createdAt: 20, previewText: '', deviceId: SRC },
      { id: 'v-old', createdAt: 10, previewText: '', deviceId: SRC },
    ])
    expect(r.driveReads).toEqual([])
  })

  it('lists nothing for a locked entry or a stale row', async () => {
    rig([{ id: 'v1', createdAt: 1 }], [{ ...VISIBLE, locked: true }])
    expect(await list()).toEqual([])
    const r = rig([{ id: 'v1', createdAt: 1 }], [VISIBLE])
    r.index.set('e1', { entryId: 'e1', authorDevice: SRC, updatedAt: 999, isDeleted: false })
    expect(await list()).toEqual([])
  })
})

describe('get_entry_version_content', () => {
  it('downloads the version from its device folder and returns the Yjs bytes', async () => {
    const r = rig([{ id: 'v1', device: PEER, createdAt: 1 }], [VISIBLE])
    r.files.set(`${PEER}/versions/v1.bin`, { entryId: 'e1', versionId: 'v1', yjs: [1, 2, 3] })
    expect(await content('v1')).toEqual([1, 2, 3])
    expect(r.driveReads).toEqual([`${PEER}/versions/v1.bin`])
    // XJV1 bytes never reach the XJS1 format guard, so nothing latches.
    expect(getFormatGuardReason()).toBeNull()
  })

  it('refuses a locked entry before any Drive read', async () => {
    const r = rig([{ id: 'v1', createdAt: 1 }], [{ ...VISIBLE, locked: true }])
    r.files.set(`${SRC}/versions/v1.bin`, { entryId: 'e1', versionId: 'v1', yjs: [1] })
    await expect(content('v1')).rejects.toThrow('Version not found')
    expect(r.driveReads).toEqual([])
  })

  it('refuses a version id the entry row does not list, or one that opens as another entry', async () => {
    const r = rig([{ id: 'v1', createdAt: 1 }], [VISIBLE])
    r.files.set(`${SRC}/versions/v1.bin`, { entryId: 'other', versionId: 'v1', yjs: [1] })
    r.files.set(`${SRC}/versions/v2.bin`, { entryId: 'e1', versionId: 'v2', yjs: [1] })
    await expect(content('v2')).rejects.toThrow('Version not found')
    await expect(content('v1')).rejects.toThrow('Version not found')
    await expect(content('../v1')).rejects.toThrow('Version not found')
  })

  it('drops the bytes when the vault locks during the download', async () => {
    const r = rig([{ id: 'v1', createdAt: 1 }], [VISIBLE])
    r.files.set(`${SRC}/versions/v1.bin`, { entryId: 'e1', versionId: 'v1', yjs: [1] })
    const opened = vi.fn()
    r.duringRead.hook = () => {
      lock('manual')
      opened()
    }
    await expect(content('v1')).rejects.toThrow(/lock/i)
    expect(opened).toHaveBeenCalledOnce()
  })
})
