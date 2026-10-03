import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Core } from '../../core/core'
import { VaultLockedError } from '../keys'
import type { WebDb } from '../storage/idb'
import { createReadSession, type ReadSession } from './readSession'

const fakes = vi.hoisted(() => ({
  hooks: [] as Array<() => void>,
  puller: null as unknown,
  vault: null as unknown,
}))

vi.mock('../keys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../keys')>()),
  onLock: (cb: () => void) => {
    fakes.hooks.push(cb)
    return () => undefined
  },
  getKeyRing: () => ({}),
}))
vi.mock('../sync/pull', () => ({ createPuller: () => fakes.puller }))
vi.mock('../vault', () => ({ createVault: () => fakes.vault }))

class Gate {
  readonly promise: Promise<void>
  open!: () => void
  constructor() {
    this.promise = new Promise<void>((resolve) => {
      this.open = resolve
    })
  }
}

const enc = new TextEncoder()
const journalFile = JSON.stringify({
  journal_id: 'j1',
  name: 'J',
  updated_at: 5,
  is_locked: true,
})

interface Rig {
  session: ReadSession
  pathsGate: { current: Gate | null }
  warmGate: { current: Gate | null }
  paths: ReturnType<typeof vi.fn>
  warmStart: ReturnType<typeof vi.fn>
  setExcluded: ReturnType<typeof vi.fn>
  lock: () => void
}

async function rig(): Promise<Rig> {
  const pathsGate: Rig['pathsGate'] = { current: null }
  const warmGate: Rig['warmGate'] = { current: null }
  const paths = vi.fn(async () => {
    await pathsGate.current?.promise
    return ['devA/journals/j1.bin']
  })
  const warmStart = vi.fn(async () => {
    await warmGate.current?.promise
    return [] as string[]
  })
  const setExcluded = vi.fn()
  const index = new Map([
    ['e1', { entryId: 'e1', authorDevice: 'devA', updatedAt: 1, isDeleted: false }],
  ])
  fakes.puller = { index, refresh: async () => ({}), warmStart }
  fakes.vault = {
    setExcludedJournalIds: setExcluded,
    load: async () => ({}),
    status: () => 'not-loaded',
  }
  const db = {
    files: { paths, get: async () => ({ ciphertext: enc.encode(journalFile) }) },
    meta: { listByPrefix: async () => [], put: async () => undefined },
  } as unknown as WebDb
  const core = { openDeviceBin: (_r: unknown, b: Uint8Array) => b } as unknown as Core
  const session = await createReadSession({ db, reader: {} as never, core })
  return {
    session,
    pathsGate,
    warmGate,
    paths,
    warmStart,
    setExcluded,
    lock: () => {
      for (const hook of [...fakes.hooks]) hook()
    },
  }
}

beforeEach(() => {
  fakes.hooks.length = 0
})
afterEach(() => {
  fakes.hooks.length = 0
})

describe('read session and lock races', () => {
  it('a lock during an in-flight taxonomy read repopulates nothing; the next unlock recomputes', async () => {
    const r = await rig()
    r.pathsGate.current = new Gate()
    const pending = r.session.ready()
    const outcome = expect(pending).rejects.toBeInstanceOf(VaultLockedError)
    await Promise.resolve()
    r.lock()
    r.pathsGate.current.open()
    await outcome
    expect(r.setExcluded).not.toHaveBeenCalled()
    expect(r.warmStart).not.toHaveBeenCalled()

    r.pathsGate.current = null
    const taxonomy = await r.session.ready()
    expect(taxonomy.excludedJournalIds).toEqual(['j1'])
    expect(r.paths).toHaveBeenCalledTimes(2)
    expect(r.setExcluded).toHaveBeenCalledTimes(1)
    expect(r.warmStart).toHaveBeenCalledTimes(1)
  })

  it('a lock during the warm start leaves no warm state behind', async () => {
    const r = await rig()
    r.warmGate.current = new Gate()
    const pending = r.session.ready()
    const outcome = expect(pending).rejects.toBeInstanceOf(VaultLockedError)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(r.warmStart).toHaveBeenCalledTimes(1)
    r.lock()
    r.warmGate.current.open()
    await outcome

    r.warmGate.current = null
    await r.session.ready()
    expect(r.warmStart).toHaveBeenCalledTimes(2)
  })

  it('a lock during pull rejects it instead of reporting stale results', async () => {
    const r = await rig()
    await r.session.ready()
    r.pathsGate.current = new Gate()
    const puller = fakes.puller as { index: Map<string, unknown>; refresh: () => Promise<unknown> }
    puller.refresh = async () => {
      puller.index = new Map(puller.index) // a new index: the taxonomy cache is invalid
      return { stale: [] }
    }
    const pending = r.session.pull()
    const outcome = expect(pending).rejects.toBeInstanceOf(VaultLockedError)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    r.lock()
    r.pathsGate.current.open()
    await outcome
  })
})
