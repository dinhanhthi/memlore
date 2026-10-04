import { IDBFactory } from 'fake-indexeddb'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DriveReader } from '../drive/client'
import { dispose, onLock, setKeyRing, lock, type KeyRing } from '../keys'
import {
  INTERVAL_MS,
  MAX_BUDGET_BYTES,
  PROTECTED_STORES,
  STALE_AFTER_MS,
  UNKNOWN_QUOTA_BUDGET_BYTES,
  WRITE_DEBOUNCE_MS,
  computeBudget,
  createEvictor,
  type EvictorEnv,
} from './evictor'
import { CACHE_LIMIT_KEY, openWebDb, WRAPPED_MASTER_HEX_LEN, type WebDb } from './idb'

const MB = 1024 * 1024
const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

let db: WebDb
let clock: number
let quota: number | undefined
let estimateFails: boolean
let timeouts: Map<number, { at: number; fn: () => void }>
let intervals: Map<number, { every: number; next: number; fn: () => void }>
let nextHandle: number
let visible: boolean

/** Runs due timers up to `clock + ms`; the evictor's own async work is flushed by the caller. */
function advance(ms: number): void {
  const end = clock + ms
  for (;;) {
    let due: { at: number; run: () => void; id: number; kind: 't' | 'i' } | null = null
    for (const [id, t] of timeouts) {
      if (t.at <= end && (due === null || t.at < due.at))
        due = { at: t.at, run: t.fn, id, kind: 't' }
    }
    for (const [id, t] of intervals) {
      if (t.next <= end && (due === null || t.next < due.at)) {
        due = { at: t.next, run: t.fn, id, kind: 'i' }
      }
    }
    if (due === null) break
    clock = due.at
    if (due.kind === 't') timeouts.delete(due.id)
    else {
      const i = intervals.get(due.id)
      if (i) i.next += i.every
    }
    due.run()
  }
  clock = end
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 50; i += 1) await new Promise((r) => setTimeout(r, 0))
}

const env = (extra: Partial<EvictorEnv> = {}): Partial<EvictorEnv> => ({
  now: () => clock,
  setTimeout: (fn, ms) => {
    nextHandle += 1
    timeouts.set(nextHandle, { at: clock + ms, fn })
    return nextHandle
  },
  clearTimeout: (h) => void timeouts.delete(h as number),
  setInterval: (fn, ms) => {
    nextHandle += 1
    intervals.set(nextHandle, { every: ms, next: clock + ms, fn })
    return nextHandle
  },
  clearInterval: (h) => void intervals.delete(h as number),
  estimate: async () => {
    if (estimateFails) throw new Error('no estimate')
    return quota === undefined ? undefined : { quota }
  },
  openDb: async () => db,
  isVisible: () => visible,
  ...extra,
})

const bytes = (n: number): Uint8Array => new Uint8Array(n).fill(1)
const putFile = (path: string, n: number, lastAccess = NOW, pinned = false) =>
  db.files.put({ path, ciphertext: bytes(n), etag: null, modifiedTime: null, lastAccess, pinned })
const putBlob = (path: string, n: number, lastAccess = NOW) =>
  db.blobs.put({ path, bytes: bytes(n), size: n, lastAccess })
const filePaths = async (): Promise<string[]> => (await db.files.paths()).sort()
const blobPaths = async (): Promise<string[]> => (await db.blobs.sizes()).map((b) => b.path).sort()

beforeEach(async () => {
  db = await openWebDb({ factory: new IDBFactory() })
  clock = NOW
  quota = 1024 * MB
  estimateFails = false
  timeouts = new Map()
  intervals = new Map()
  nextHandle = 0
  visible = true
})

afterEach(() => {
  dispose()
  vi.unstubAllGlobals()
})

describe('computeBudget', () => {
  it('is min(500 MB, 50% of quota)', () => {
    expect(computeBudget(1024 * MB, null)).toBe(500 * MB)
    expect(computeBudget(400 * MB, null)).toBe(200 * MB)
    expect(computeBudget(10 * 1024 * MB, null)).toBe(MAX_BUDGET_BYTES)
  })

  it('fails toward 200 MB when the quota is unknown', () => {
    expect(computeBudget(undefined, null)).toBe(UNKNOWN_QUOTA_BUDGET_BYTES)
    expect(computeBudget(0, null)).toBe(UNKNOWN_QUOTA_BUDGET_BYTES)
    expect(computeBudget(Number.NaN, null)).toBe(UNKNOWN_QUOTA_BUDGET_BYTES)
  })

  it('lets the user limit lower the budget but never raise it', () => {
    expect(computeBudget(1024 * MB, 100 * MB)).toBe(100 * MB)
    expect(computeBudget(1024 * MB, 1)).toBe(50 * MB) // floor of the override
    expect(computeBudget(400 * MB, 500 * MB)).toBe(200 * MB) // cap wins
    expect(computeBudget(1024 * MB, 9999 * MB)).toBe(500 * MB)
  })
})

describe('eviction rules', () => {
  /** Quota 2 bytes: budget 1 byte, i.e. everything evictable must go. */
  const fullEviction = async (): Promise<void> => {
    quota = 2
    const e = createEvictor(env())
    const r = await e.maybeEvict('manual')
    expect(r?.budget).toBe(1)
  }

  it('a full eviction keeps drafts, device, meta hints, authority, small files and the pinned set', async () => {
    await db.drafts.put({ entryId: 'd1', sealed: bytes(9), updatedAt: 1 })
    await db.device.put({
      deviceId: 'web-1',
      wrappedMasterHex: 'ab'.repeat(WRAPPED_MASTER_HEX_LEN / 2),
      kekSaltHex: 'cd'.repeat(16),
      recoveryGeneration: 1,
      masterFingerprint: 'fp',
      name: 'web',
    })
    await db.meta.put({ key: 'journal-seen:j1', value: 1 })
    const protectedFiles = [
      '.meta/keyring/_content.json',
      '.meta/control.json',
      'dev/metadata.json',
      'dev/outbox-acks.bin',
      'dev/journals/j1.bin',
      'dev/tags.bin',
      'dev/templates.bin',
      'dev/entries/pinned.bin',
    ]
    for (const p of protectedFiles) await putFile(p, 10, 1, p.endsWith('pinned.bin'))
    await putFile('dev/entries/e1.bin', 10)
    await putBlob('media/m1', 10)
    await putBlob('media/m1.thumb', 10)

    await fullEviction()

    expect(await filePaths()).toEqual([...protectedFiles].sort())
    expect(await blobPaths()).toEqual([])
    expect(await db.drafts.get('d1')).toBeDefined()
    expect(await db.device.get()).toBeDefined()
    expect(await db.meta.get('journal-seen:j1')).toBeDefined()
  })

  it('never opens a protected store', () => {
    for (const name of ['drafts', 'intents', 'device', 'meta']) {
      expect(PROTECTED_STORES.has(name)).toBe(true)
    }
  })

  it('evicts entries older than 30 days even when under budget, unless protected', async () => {
    await putFile('dev/entries/old.bin', 10, NOW - STALE_AFTER_MS - 1)
    await putFile('dev/entries/fresh.bin', 10, NOW - STALE_AFTER_MS + DAY)
    await putFile('dev/entries/oldpinned.bin', 10, 1, true)
    await putFile('dev/entries/vetoed.bin', 10, 1)
    await putFile('dev/metadata.json', 10, 1)
    await putBlob('media/old', 10, NOW - 60 * DAY)
    const e = createEvictor(env({ protect: (i) => i.path.endsWith('vetoed.bin') }))
    const r = await e.maybeEvict('manual')
    expect(r?.evicted).toBe(2)
    expect(await filePaths()).toEqual([
      'dev/entries/fresh.bin',
      'dev/entries/oldpinned.bin',
      'dev/entries/vetoed.bin',
      'dev/metadata.json',
    ])
    expect(await blobPaths()).toEqual([])
  })

  it('does nothing when under the budget and nothing is stale', async () => {
    await putFile('dev/entries/e1.bin', 10)
    await putBlob('media/m1', 10)
    const r = await createEvictor(env()).maybeEvict('manual')
    expect(r).toMatchObject({ evicted: 0, usageBefore: 20, usageAfter: 20 })
  })

  it('evicts LRU in tier order (media, thumbnails, entries) and stops under 80% of the budget', async () => {
    // budget = 100 bytes (quota 200); usage 140 -> evict until usage < 80
    quota = 200
    await putFile('dev/entries/e-old.bin', 20, NOW - 3 * DAY)
    await putFile('dev/entries/e-new.bin', 20, NOW - 1 * DAY)
    await putBlob('media/thumbs-old.thumb', 20, NOW - 4 * DAY)
    await putBlob('media/thumbs-new.thumb', 20, NOW - 2 * DAY)
    await putBlob('media/full-old', 20, NOW - 6 * DAY)
    await putBlob('media/full-new', 20, NOW - 5 * DAY)
    await putFile('dev/metadata.json', 20, NOW - 29 * DAY) // protected, counts toward usage
    const order: string[] = []
    const real = db.blobs.delete
    const realFile = db.files.delete
    db.blobs.delete = (p: string) => (order.push(p), real(p))
    db.files.delete = (p: string) => (order.push(p), realFile(p))
    const r = await createEvictor(env()).maybeEvict('manual')
    expect(r?.budget).toBe(100)
    expect(r?.usageBefore).toBe(140)
    // 140 -> 120 -> 100 -> 80 (not < 80) -> 60: four evictions
    expect(order).toEqual([
      'media/full-old',
      'media/full-new',
      'media/thumbs-old.thumb',
      'media/thumbs-new.thumb',
    ])
    expect(r?.usageAfter).toBe(60)
    expect(await filePaths()).toEqual([
      'dev/entries/e-new.bin',
      'dev/entries/e-old.bin',
      'dev/metadata.json',
    ])
  })

  it('evicts entry payloads last, oldest first', async () => {
    quota = 100 // budget 50, target 40; usage 60
    await putFile('dev/entries/a.bin', 20, NOW - 3 * DAY)
    await putFile('dev/entries/b.bin', 20, NOW - 2 * DAY)
    await putFile('dev/entries/c.bin', 20, NOW - 1 * DAY)
    await createEvictor(env()).maybeEvict('manual')
    expect(await filePaths()).toEqual(['dev/entries/c.bin']) // 60 -> 40 (not < 40) -> 20
  })

  it('an estimate that fails or is missing uses the conservative default budget', async () => {
    estimateFails = true
    expect((await createEvictor(env()).maybeEvict('manual'))?.budget).toBe(
      UNKNOWN_QUOTA_BUDGET_BYTES,
    )
    estimateFails = false
    quota = undefined
    expect((await createEvictor(env()).maybeEvict('manual'))?.budget).toBe(
      UNKNOWN_QUOTA_BUDGET_BYTES,
    )
  })

  it('the user limit lowers the budget but cannot raise it', async () => {
    const e = createEvictor(env())
    quota = 400 * MB
    e.setBudgetBytes(500 * MB)
    expect((await e.maybeEvict('manual'))?.budget).toBe(200 * MB)
    e.setBudgetBytes(60 * MB)
    expect((await e.maybeEvict('manual'))?.budget).toBe(60 * MB)
    e.setBudgetBytes(null)
    expect((await e.maybeEvict('manual'))?.budget).toBe(200 * MB)
  })

  it('emits a stats-changed notification once the persisted limit loads', async () => {
    await db.meta.put({ key: CACHE_LIMIT_KEY, value: 60 * MB })
    const changed = vi.fn()
    const e = createEvictor(env({ onStatsChanged: changed }))
    e.start()
    await settle()
    expect(changed).toHaveBeenCalledTimes(1) // the limit load; the unlock run evicted nothing
    await e.maybeEvict('manual')
    expect(changed).toHaveBeenCalledTimes(1) // loaded once per start
  })

  it('accounts exactly the stored size of a short, capped download', async () => {
    const reader = new DriveReader({
      getToken: async () => 'tok',
      fetchImpl: async () =>
        new Response(new Uint8Array(40).fill(2), { headers: { 'content-length': '5000' } }),
    })
    const body = await reader.getFile('abc', 10_000)
    await db.blobs.put({ path: 'media/short', bytes: body, size: body.length, lastAccess: NOW })
    expect(body.buffer.byteLength).toBe(40)
    expect((await db.blobs.sizes())[0].size).toBe(40)
    expect((await db.blobs.get('media/short'))?.bytes.buffer.byteLength).toBe(40)
  })

  it('makes zero fetch calls and the module imports no drive code', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await putFile('dev/entries/e1.bin', 10, 1)
    await createEvictor(env()).maybeEvict('manual')
    expect(fetchSpy).not.toHaveBeenCalled()
    const source = readFileSync(new URL('./evictor.ts', import.meta.url), 'utf8')
    const imports = source.split('\n').filter((l) => /^\s*(import|export) .*from /.test(l))
    expect(imports.filter((l) => /drive|core\/core|wasm/i.test(l))).toEqual([])
  })

  it('swallows a failure and resolves null', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const e = createEvictor(env({ openDb: async () => Promise.reject(new Error('boom')) }))
    await expect(e.maybeEvict('manual')).resolves.toBeNull()
    expect(spy).toHaveBeenCalledOnce()
    expect(JSON.stringify(spy.mock.calls)).not.toContain('boom')
    spy.mockRestore()
  })

  it('is single-flight', async () => {
    let opens = 0
    const e = createEvictor(env({ openDb: async () => ((opens += 1), db) }))
    const a = e.maybeEvict('manual')
    const b = e.maybeEvict('interval')
    expect(b).toBe(a)
    await a
    await settle()
    expect(opens).toBe(1)
  })

  it('a manual run requested during a run waits for it, then runs again with the new budget', async () => {
    let estimates = 0
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const e = createEvictor(
      env({
        estimate: async () => {
          estimates += 1
          if (estimates === 1) await gate
          return { quota }
        },
      }),
    )
    const a = e.maybeEvict('interval')
    await settle()
    e.setBudgetBytes(60 * MB)
    const b = e.maybeEvict('manual')
    expect(b).not.toBe(a)
    release()
    const result = await b
    expect(estimates).toBe(2)
    expect(result?.reason).toBe('manual')
    expect(result?.budget).toBe(60 * MB)
  })

  it('retries loading the persisted limit after a failed read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await db.meta.put({ key: CACHE_LIMIT_KEY, value: 60 * MB })
    let failures = 1
    const flaky = {
      files: db.files,
      blobs: db.blobs,
      meta: {
        get: async (key: string) => {
          if (failures > 0) {
            failures -= 1
            throw new Error('read failed')
          }
          return db.meta.get(key)
        },
      },
    } as unknown as WebDb
    const e = createEvictor(env({ openDb: async () => flaky }))
    expect(await e.maybeEvict('manual')).toBeNull()
    expect((await e.maybeEvict('manual'))?.budget).toBe(60 * MB)
    vi.restoreAllMocks()
  })

  it('stop() drops the in-session limit and the next start re-reads the persisted one', async () => {
    await db.meta.put({ key: CACHE_LIMIT_KEY, value: 100 * MB })
    const e = createEvictor(env())
    e.start()
    await settle()
    e.setBudgetBytes(60 * MB)
    expect(await e.budgetBytes()).toBe(60 * MB)
    e.stop()
    e.start()
    await settle()
    expect(await e.budgetBytes()).toBe(100 * MB)
    await db.meta.delete(CACHE_LIMIT_KEY)
    e.setBudgetBytes(60 * MB)
    e.stop()
    e.start()
    await settle()
    expect(await e.budgetBytes()).toBe(500 * MB) // nothing persisted: the in-session limit is gone
  })

  it('budgetBytes() on a stopped evictor does not load the persisted limit', async () => {
    await db.meta.put({ key: CACHE_LIMIT_KEY, value: 100 * MB })
    const e = createEvictor(env())
    expect(await e.budgetBytes()).toBe(500 * MB) // never started
    e.start()
    await settle()
    expect(await e.budgetBytes()).toBe(100 * MB)
    e.stop()
    await db.meta.put({ key: CACHE_LIMIT_KEY, value: 70 * MB })
    expect(await e.budgetBytes()).toBe(500 * MB) // stopped: no reload, nothing left over
    e.start()
    await settle()
    expect(await e.budgetBytes()).toBe(70 * MB) // the next start re-reads
  })

  it('a manual evict queued behind a running pass is dropped when the vault locks meanwhile', async () => {
    await putFile('dev/entries/old.bin', 10, 1)
    await db.meta.put({ key: CACHE_LIMIT_KEY, value: 100 * MB })
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const e = createEvictor(
      env({
        estimate: async () => {
          calls += 1
          if (calls === 1) await gate
          return { quota }
        },
      }),
    )
    e.start() // the unlock pass is in flight, waiting on the gate
    await settle()
    const manual = e.maybeEvict('manual') // queued behind it
    e.stop() // lock
    release()
    expect(await manual).toBeNull()
    await settle()
    expect(await filePaths()).toEqual(['dev/entries/old.bin']) // nothing deleted after the lock
    expect(calls).toBe(1) // no new pass started
    expect(await e.budgetBytes()).toBe(500 * MB) // no override / limitLoaded left on a stopped evictor
  })
})

describe('schedule', () => {
  it('runs on start, every 10 min while idle, and stops', async () => {
    await putFile('dev/entries/old.bin', 10, 1)
    const e = createEvictor(env())
    e.start()
    await settle()
    expect(await filePaths()).toEqual([]) // the unlock run (stale rule)
    await putFile('dev/entries/old2.bin', 10, 1)
    advance(INTERVAL_MS - 1)
    await settle()
    expect(await filePaths()).toEqual(['dev/entries/old2.bin'])
    advance(1)
    await settle()
    expect(await filePaths()).toEqual([])
    await putFile('dev/entries/old3.bin', 10, 1)
    e.stop()
    advance(INTERVAL_MS * 3)
    await settle()
    expect(await filePaths()).toEqual(['dev/entries/old3.bin'])
    expect(intervals.size).toBe(0)
  })

  it('skips an interval tick within a minute of a cache write, and while the tab is hidden', async () => {
    const e = createEvictor(env())
    e.start()
    await settle()
    advance(INTERVAL_MS - 30_000)
    e.notifyCacheWrite()
    advance(WRITE_DEBOUNCE_MS) // the debounced check runs (nothing stale yet)
    await settle()
    await putFile('dev/entries/old.bin', 10, 1)
    advance(30_000 - WRITE_DEBOUNCE_MS) // interval tick, 30 s after the write: not idle
    await settle()
    expect(await filePaths()).toEqual(['dev/entries/old.bin'])
    visible = false
    advance(INTERVAL_MS) // idle by time, but the tab is hidden
    await settle()
    expect(await filePaths()).toEqual(['dev/entries/old.bin'])
    visible = true
    advance(INTERVAL_MS)
    await settle()
    expect(await filePaths()).toEqual([])
  })

  it('debounces writes into one check that only acts when over the budget', async () => {
    quota = 100 // budget 50
    let estimates = 0
    const e = createEvictor(env({ estimate: async () => ((estimates += 1), { quota }) }))
    e.start()
    await settle()
    estimates = 0
    await putFile('dev/entries/a.bin', 30, NOW)
    e.notifyCacheWrite()
    advance(500)
    await putFile('dev/entries/b.bin', 30, NOW - DAY)
    e.notifyCacheWrite()
    advance(WRITE_DEBOUNCE_MS - 1)
    await settle()
    expect(estimates).toBe(0) // still debounced
    advance(1)
    await settle()
    expect(estimates).toBe(1)
    expect(await filePaths()).toEqual(['dev/entries/a.bin']) // 60 > 50: older one evicted (30 < 40)
  })

  it('ignores cache writes while stopped', async () => {
    const e = createEvictor(env())
    e.notifyCacheWrite()
    expect(timeouts.size).toBe(0)
  })

  it('stops with the key holder lock hook and does not start twice', async () => {
    const e = createEvictor(env())
    e.start()
    e.start()
    expect(intervals.size).toBe(1)
    const off = onLock(() => e.stop())
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    lock('manual')
    off()
    expect(e.running).toBe(false)
    expect(intervals.size).toBe(0)
    await settle()
  })
})
