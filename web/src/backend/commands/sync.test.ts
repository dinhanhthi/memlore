import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { oauth } from '../drive/oauth'
import { createDraftManager, resetDraftsAutostartForTest, type DraftManager } from '../drafts'
import { dispose, lock, setKeyRing, type KeyRing } from '../keys'
import { WRAPPED_MASTER_HEX_LEN, openWebDb } from '../storage/idb'
import type { PushResult } from '../sync/push'
import type { PullOutcome } from './readSession'
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  FOCUS_MIN_AGE_MS,
  INTERVAL_MS,
  MSG_FORMAT_READ_ONLY,
  MSG_SYNC_DEGRADED,
  PUSH_DEBOUNCE_MS,
  configureSyncEnv,
  startSyncSchedule,
  stopSyncSchedule,
  syncHandlers,
  type SyncStatusEvent,
} from './sync'

type Listener = () => void

interface Timer {
  id: number
  at: number
  fn: () => void
}

class Deferred<T> {
  readonly promise: Promise<T>
  resolve!: (value: T) => void
  reject!: (error: unknown) => void
  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
  }
}

const NOOP: PullOutcome = { stale: [], changed: false }

function named(name: string, message: string): Error {
  const error = new Error(message)
  error.name = name
  return error
}

/** A fake clock, timers, tab and pull; `pull` resolves with `outcome` unless a script is queued. */
function harness() {
  let now = 1_800_000_000_000
  let nextId = 1
  let visibility = 'visible'
  const timers = new Map<number, Timer>()
  const winListeners = new Map<string, Set<Listener>>()
  const docListeners = new Map<string, Set<Listener>>()
  const events: Array<{ event: string; payload: unknown }> = []
  const script: Array<() => Promise<PullOutcome>> = []
  const pushScript: Array<() => Promise<PushResult>> = []
  const flagListeners = new Set<() => void>()
  const h = {
    pulls: 0,
    outcome: NOOP,
    pushes: 0,
    /** The cached write flag. Off by default, so the pull-only tests never push. */
    flag: false,
    /** The unpushed draft count; a push sets it to its result's `pending`. */
    pending: 0,
    pushResult: { pushed: 0, skipped: 0, pending: 0 } as PushResult,
    /** `pull` / `push`, in call order. */
    log: [] as string[],
    queuePush: (fn: () => Promise<PushResult>) => pushScript.push(fn),
    /** Replaces the scripted push entirely (its result is returned as is). */
    pushImpl: null as (() => Promise<PushResult>) | null,
    online: () => {
      for (const fn of [...(winListeners.get('online') ?? [])]) fn()
    },
    /** The cached write flag turns on (its first successful fetch after unlock). */
    flagOn: () => {
      h.flag = true
      for (const fn of [...flagListeners]) fn()
    },
    events,
    states: () =>
      events
        .filter((e) => e.event === 'sync:status-changed')
        .map((e) => (e.payload as SyncStatusEvent).state),
    names: () => events.map((e) => e.event),
    last: () =>
      events.filter((e) => e.event === 'sync:status-changed').at(-1)?.payload as
        | SyncStatusEvent
        | undefined,
    timerCount: () => timers.size,
    listenerCount: () =>
      [...winListeners.values(), ...docListeners.values()].reduce((n, s) => n + s.size, 0),
    queue: (fn: () => Promise<PullOutcome>) => script.push(fn),
    setVisible: (value: 'visible' | 'hidden') => {
      visibility = value
      for (const fn of [...(docListeners.get('visibilitychange') ?? [])]) fn()
    },
    focus: () => {
      for (const fn of [...(winListeners.get('focus') ?? [])]) fn()
    },
    /** Moves the clock forward, firing due timers in order and letting pulls settle. */
    advance: async (ms: number) => {
      const target = now + ms
      for (;;) {
        const due = [...timers.values()]
          .filter((t) => t.at <= target)
          .sort((a, b) => a.at - b.at)[0]
        if (due === undefined) break
        timers.delete(due.id)
        now = due.at
        due.fn()
        await settle()
      }
      now = target
      await settle()
    },
    settle: () => settle(),
  }
  const target = (map: Map<string, Set<Listener>>) => ({
    addEventListener: (type: string, fn: Listener) => {
      map.set(type, (map.get(type) ?? new Set()).add(fn))
    },
    removeEventListener: (type: string, fn: Listener) => {
      map.get(type)?.delete(fn)
    },
  })
  configureSyncEnv({
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++
      timers.set(id, { id, at: now + ms, fn })
      return id
    },
    clearTimeout: (id) => {
      timers.delete(id as number)
    },
    emit: (event, payload) => {
      events.push({ event, payload })
    },
    emitChanged: () => {
      events.push({ event: 'memlore:entries-changed', payload: undefined })
    },
    cachedWriteFlag: () => h.flag,
    onWriteFlagOn: (fn) => {
      flagListeners.add(fn)
      return () => flagListeners.delete(fn)
    },
    pendingCount: () => h.pending,
    push: async () => {
      h.pushes += 1
      h.log.push('push')
      if (h.pushImpl !== null) return h.pushImpl()
      const next = pushScript.shift()
      // A fresh object per run, like `pushAll`.
      const result = next === undefined ? { ...h.pushResult } : await next()
      h.pending = result.pending
      return result
    },
    pull: async () => {
      h.pulls += 1
      h.log.push('pull')
      const next = script.shift()
      return next === undefined ? h.outcome : next()
    },
    window: target(winListeners),
    document: {
      ...target(docListeners),
      get visibilityState() {
        return visibility
      },
    },
  })
  return h
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

const RING = { lock: () => undefined } as unknown as KeyRing

beforeEach(() => {
  setKeyRing(RING)
})

afterEach(() => {
  stopSyncSchedule()
  configureSyncEnv({})
  dispose()
})

describe('schedule triggers', () => {
  it('pulls on start (unlock) and reports syncing then synced', async () => {
    const h = harness()
    startSyncSchedule()
    await h.settle()
    expect(h.pulls).toBe(1)
    expect(h.states()).toEqual(['syncing', 'synced'])
    expect(h.last()).toMatchObject({
      state: 'synced',
      provider: 'gdrive',
      enabled: true,
      entriesPending: 0,
      error: null,
    })
    expect(h.last()?.lastSync).toBe(1_800_000_000)
  })

  it('reports a degraded pull as a synced phase with a message, cleared by a clean pull', async () => {
    const h = harness()
    h.outcome = {
      stale: [],
      changed: false,
      degraded: [{ device: 'd1', reason: 'manifest-oversize' }],
    }
    startSyncSchedule()
    await h.settle()
    expect(h.last()).toMatchObject({ state: 'synced', error: MSG_SYNC_DEGRADED })
    await expect(syncHandlers.get_sync_status({})).resolves.toMatchObject({
      error: MSG_SYNC_DEGRADED,
    })
    h.outcome = NOOP
    await syncHandlers.sync_now({})
    expect(h.last()).toMatchObject({ state: 'synced', error: null })
    expect(await syncHandlers.get_sync_status({})).not.toHaveProperty('error')
  })

  it('merges every retention notice of a pull into one synced note, then clears it', async () => {
    const h = harness()
    h.outcome = { stale: [], changed: false, notices: ['first notice', 'second', 'third'] }
    startSyncSchedule()
    await h.settle()
    expect(h.last()).toMatchObject({ state: 'synced', error: 'first notice (and 2 more edits)' })
    h.outcome = NOOP
    await syncHandlers.sync_now({})
    expect(h.last()).toMatchObject({ state: 'synced', error: null })
  })

  it('shows a single notice as is', async () => {
    const h = harness()
    h.outcome = { stale: [], changed: false, notices: ['only notice'] }
    startSyncSchedule()
    await h.settle()
    expect(h.last()).toMatchObject({ state: 'synced', error: 'only notice' })
  })

  it('a push error wins over notices; all of them show once the error clears', async () => {
    const h = harness()
    h.flag = true
    h.pending = 1
    h.pushResult = { pushed: 0, skipped: 0, pending: 1, error: new Error('quota') }
    startSyncSchedule()
    await h.settle()
    expect(h.last()).toMatchObject({ state: 'error', error: 'quota' })
    for (const notice of ['notice a', 'notice b']) {
      h.outcome = { stale: [], changed: false, notices: [notice] }
      await h.advance(FOCUS_MIN_AGE_MS + 1)
      h.focus()
      await h.settle()
      expect(h.last()).toMatchObject({ state: 'error', error: 'quota' })
    }
    expect(h.pulls).toBe(3)
    h.outcome = NOOP
    h.pushResult = PUSHED_ALL
    h.online()
    await h.settle()
    expect(h.last()).toMatchObject({ state: 'synced', error: 'notice a (and 1 more edit)' })
  })

  it('a notice is shown over the degraded note once, then the degraded note returns', async () => {
    const h = harness()
    const degraded: PullOutcome['degraded'] = [{ device: 'd1', reason: 'manifest-oversize' }]
    h.outcome = { stale: [], changed: false, degraded, notices: ['a notice'] }
    startSyncSchedule()
    await h.settle()
    expect(h.last()).toMatchObject({ state: 'synced', error: 'a notice' })
    h.outcome = { stale: [], changed: false, degraded }
    await syncHandlers.sync_now({})
    expect(h.last()).toMatchObject({ state: 'synced', error: MSG_SYNC_DEGRADED })
  })

  it('does not pull on start while the tab is hidden, then pulls once it is visible', async () => {
    const h = harness()
    h.setVisible('hidden')
    startSyncSchedule()
    await h.settle()
    expect(h.pulls).toBe(0)
    h.setVisible('visible')
    await h.settle()
    expect(h.pulls).toBe(1)
  })

  it('pulls on focus only when the last attempt is older than 30 s', async () => {
    const h = harness()
    startSyncSchedule()
    await h.settle()
    await h.advance(FOCUS_MIN_AGE_MS - 1000)
    h.focus()
    await h.settle()
    expect(h.pulls).toBe(1)
    await h.advance(2000)
    h.focus()
    await h.settle()
    expect(h.pulls).toBe(2)
  })

  it('does not pull on focus or visibility change while hidden', async () => {
    const h = harness()
    startSyncSchedule()
    await h.settle()
    h.setVisible('hidden')
    await h.advance(FOCUS_MIN_AGE_MS * 2)
    h.focus()
    await h.settle()
    expect(h.pulls).toBe(1)
  })

  it('pulls every 5 min while visible and skips the ticks while hidden', async () => {
    const h = harness()
    startSyncSchedule()
    await h.settle()
    await h.advance(INTERVAL_MS)
    expect(h.pulls).toBe(2)
    h.setVisible('hidden')
    await h.advance(INTERVAL_MS * 2)
    expect(h.pulls).toBe(2)
    h.setVisible('visible')
    await h.settle()
    expect(h.pulls).toBe(3)
    await h.advance(INTERVAL_MS)
    expect(h.pulls).toBe(4)
  })

  it('joins a pull in flight instead of starting another', async () => {
    const h = harness()
    const gate = new Deferred<PullOutcome>()
    h.queue(() => gate.promise)
    startSyncSchedule()
    await h.settle()
    await h.advance(FOCUS_MIN_AGE_MS + 1)
    h.focus()
    const summary = syncHandlers.sync_now({}) as Promise<{ pulled: number; errors: string[] }>
    await h.settle()
    expect(h.pulls).toBe(1)
    gate.resolve({ stale: ['a', 'b'], changed: true })
    await expect(summary).resolves.toEqual({ pushed: 0, pulled: 2, merged: 0, errors: [] })
    expect(h.states()).toEqual(['syncing', 'synced'])
  })
})

describe('sync_now', () => {
  it('rejects while locked', async () => {
    harness()
    lock('manual')
    await expect(syncHandlers.sync_now({})).rejects.toThrow('vault is locked')
  })

  it('resolves after the pull with the summary and the status', async () => {
    const h = harness()
    h.outcome = { stale: ['x'], changed: true }
    await expect(syncHandlers.sync_now({})).resolves.toEqual({
      pushed: 0,
      pulled: 1,
      merged: 0,
      errors: [],
    })
    expect(h.states()).toEqual(['syncing', 'synced'])
    await expect(syncHandlers.get_sync_status({})).resolves.toMatchObject({
      lastSync: 1_800_000_000,
    })
  })

  it('reports a failed pull in errors and resets the backoff', async () => {
    const h = harness()
    startSyncSchedule()
    await h.settle()
    h.queue(async () => {
      throw named('PullTransientError', 'Could not read control.json from the cloud; retry later')
    })
    const failed = (await syncHandlers.sync_now({})) as { errors: string[] }
    expect(failed.errors).toEqual(['Could not read control.json from the cloud; retry later'])
    const ok = (await syncHandlers.sync_now({})) as { errors: string[] }
    expect(ok.errors).toEqual([])
    expect(h.states()).toEqual(['syncing', 'synced', 'syncing', 'error', 'syncing', 'synced'])
  })
})

describe('failures', () => {
  it('backs off 30 s, 60 s, ... capped at 5 min, and keeps the schedule alive', async () => {
    const h = harness()
    const fail = (): void => {
      h.queue(async () => {
        throw new Error('offline')
      })
    }
    for (let i = 0; i < 7; i++) fail()
    startSyncSchedule()
    await h.settle()
    expect(h.pulls).toBe(1)
    expect(h.last()).toMatchObject({ state: 'error', error: 'offline' })
    await h.advance(BACKOFF_BASE_MS - 1)
    expect(h.pulls).toBe(1)
    await h.advance(1)
    expect(h.pulls).toBe(2)
    await h.advance(BACKOFF_BASE_MS * 2 - 1)
    expect(h.pulls).toBe(2)
    await h.advance(1)
    expect(h.pulls).toBe(3)
    // 120 s, 240 s, then capped at 300 s.
    await h.advance(BACKOFF_BASE_MS * 4)
    expect(h.pulls).toBe(4)
    await h.advance(BACKOFF_BASE_MS * 8)
    expect(h.pulls).toBe(5)
    await h.advance(BACKOFF_MAX_MS - 1)
    expect(h.pulls).toBe(5)
    await h.advance(1)
    expect(h.pulls).toBe(6)
  })

  it('does not retry on focus inside the backoff window', async () => {
    const h = harness()
    h.queue(async () => {
      throw new Error('offline')
    })
    startSyncSchedule()
    await h.settle()
    await h.advance(FOCUS_MIN_AGE_MS - 1)
    h.focus()
    await h.settle()
    expect(h.pulls).toBe(1)
  })

  it('recovers after a failure and emits no entries-changed for it', async () => {
    const h = harness()
    h.queue(async () => {
      throw new Error('offline')
    })
    startSyncSchedule()
    await h.settle()
    await h.advance(BACKOFF_BASE_MS)
    expect(h.states()).toEqual(['syncing', 'error', 'syncing', 'synced'])
    expect(h.names()).not.toContain('memlore:entries-changed')
    expect(h.last()?.error).toBeNull()
  })

  it('halts on ReonboardRequiredError: error with the message, no retries', async () => {
    const h = harness()
    const message = 'This browser must be re-enrolled (slot-missing).'
    h.queue(async () => {
      // The puller locks the vault before it throws.
      lock('revoked')
      throw named('ReonboardRequiredError', message)
    })
    startSyncSchedule()
    await h.settle()
    expect(h.last()).toMatchObject({ state: 'error', error: message })
    expect(h.timerCount()).toBe(0)
    expect(h.listenerCount()).toBe(0)
    await h.advance(INTERVAL_MS * 3)
    h.focus()
    expect(h.pulls).toBe(1)
  })

  it('halts on FormatUnsupportedError: read-only message, no repeated retries', async () => {
    const h = harness()
    h.queue(async () => {
      throw named('FormatUnsupportedError', 'Unsupported format: control.json has version 9')
    })
    startSyncSchedule()
    await h.settle()
    expect(h.last()?.state).toBe('error')
    expect(h.last()?.error).toContain(MSG_FORMAT_READ_ONLY)
    expect(h.last()?.error).toContain('version 9')
    await h.advance(INTERVAL_MS * 3)
    h.focus()
    await h.settle()
    expect(h.pulls).toBe(1)
  })

  it('lets sync_now retry after a format halt', async () => {
    const h = harness()
    h.queue(async () => {
      throw named('FormatUnsupportedError', 'v9')
    })
    startSyncSchedule()
    await h.settle()
    const summary = (await syncHandlers.sync_now({})) as { errors: string[] }
    expect(summary.errors).toEqual([])
    expect(h.pulls).toBe(2)
  })
})

describe('lock', () => {
  it('stops the schedule: no timers, no listeners, no pulls', async () => {
    const h = harness()
    startSyncSchedule()
    await h.settle()
    expect(h.timerCount()).toBeGreaterThan(0)
    expect(h.listenerCount()).toBeGreaterThan(0)
    lock('manual')
    expect(h.timerCount()).toBe(0)
    expect(h.listenerCount()).toBe(0)
    h.focus()
    await h.advance(INTERVAL_MS * 2)
    expect(h.pulls).toBe(1)
  })

  it('discards the result of a pull that finishes after the lock', async () => {
    const h = harness()
    const gate = new Deferred<PullOutcome>()
    h.queue(() => gate.promise)
    startSyncSchedule()
    await h.settle()
    lock('idle')
    gate.resolve({ stale: ['a'], changed: true })
    await h.settle()
    expect(h.names()).toEqual(['sync:status-changed'])
    expect(h.states()).toEqual(['syncing'])
  })

  it('does not join a pull from before the lock: the new schedule starts its own', async () => {
    const h = harness()
    const gate = new Deferred<PullOutcome>()
    h.queue(() => gate.promise)
    startSyncSchedule()
    await h.settle()
    lock('manual')
    setKeyRing(RING)
    startSyncSchedule()
    await h.settle()
    expect(h.pulls).toBe(2)
    expect(h.states().at(-1)).toBe('synced')
    gate.resolve({ stale: ['a'], changed: true })
    await h.settle()
    expect(h.names()).not.toContain('memlore:entries-changed')
  })

  it('restarts cleanly on the next unlock', async () => {
    const h = harness()
    startSyncSchedule()
    await h.settle()
    lock('manual')
    setKeyRing(RING)
    startSyncSchedule()
    await h.settle()
    expect(h.pulls).toBe(2)
    expect(h.timerCount()).toBe(1)
  })
})

describe('events', () => {
  it('emits entries-changed after a pull that changed the content, after the status', async () => {
    const h = harness()
    h.outcome = { stale: ['a'], changed: true }
    startSyncSchedule()
    await h.settle()
    expect(h.names()).toEqual([
      'sync:status-changed',
      'sync:status-changed',
      'memlore:entries-changed',
    ])
  })

  it('does not emit entries-changed after a no-op pull', async () => {
    const h = harness()
    startSyncSchedule()
    await h.settle()
    expect(h.names()).toEqual(['sync:status-changed', 'sync:status-changed'])
  })

  it('never emits sync:progress', async () => {
    const h = harness()
    h.outcome = { stale: ['a'], changed: true }
    startSyncSchedule()
    await h.settle()
    expect(h.names()).not.toContain('sync:progress')
  })
})

describe('status and settings', () => {
  it('says Google Drive only while unlocked', async () => {
    harness()
    await expect(syncHandlers.get_sync_status({})).resolves.toEqual({
      enabled: true,
      configured: true,
      provider: 'gdrive',
      lastSync: null,
      entriesPending: 0,
    })
    await expect(syncHandlers.get_sync_settings({})).resolves.toEqual({
      intervalMinutes: 5,
      onSave: false,
      onLaunch: true,
    })
  })

  it('answers the pre-unlock defaults while locked, like the desktop placeholder database', async () => {
    harness()
    lock('manual')
    await expect(syncHandlers.get_sync_status({})).resolves.toEqual({
      enabled: false,
      configured: false,
      provider: null,
      lastSync: null,
      entriesPending: 0,
    })
  })

  it('reports not connected without a Drive session', async () => {
    harness()
    await expect(syncHandlers.gdrive_get_status({})).resolves.toEqual({ connected: false })
  })
})

describe('gdrive_refresh_storage_quota', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  /** A connected browser: OAuth session plus an enrolled device record. */
  async function connect(): Promise<void> {
    vi.spyOn(oauth, 'isConnected').mockReturnValue(true)
    vi.spyOn(oauth, 'getAccessToken').mockResolvedValue('tok')
    const factory = new IDBFactory()
    vi.stubGlobal('indexedDB', factory)
    const db = await openWebDb({ factory })
    await db.device.put({
      deviceId: 'web-1234',
      wrappedMasterHex: 'ab'.repeat(WRAPPED_MASTER_HEX_LEN / 2),
      kekSaltHex: 'cd'.repeat(16),
      recoveryGeneration: 1,
      masterFingerprint: 'fp-1',
      name: 'Memlore Web',
    })
    db.close()
  }

  function scriptDrive(about: Response, pages: Response[]): string[] {
    const urls: string[] = []
    let page = 0
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      urls.push(String(input))
      const auth = new Headers(init?.headers).get('authorization')
      if (auth !== 'Bearer tok') return new Response('unauthorized', { status: 401 })
      if (String(input).includes('/drive/v3/about')) return about
      if (String(input).includes('/drive/v3/files')) {
        const next = pages[page]
        page += 1
        return next ?? new Response('missing page', { status: 500 })
      }
      return new Response('unexpected', { status: 500 })
    })
    return urls
  }

  const aboutOk = (email = 'ada@example.com', usage = '1000', limit?: string) =>
    Response.json({
      user: { emailAddress: email },
      storageQuota: { usage, ...(limit === undefined ? {} : { limit }) },
    })

  it('reports the signed-in email, Drive quota, and bytes Memlore occupies', async () => {
    const h = harness()
    await connect()
    startSyncSchedule()
    await h.settle()
    const urls = scriptDrive(aboutOk('ada@example.com', '1000', '5000'), [
      Response.json({ files: [{ size: '40' }, { size: 'nope' }], nextPageToken: 'p2' }),
      Response.json({ files: [{ size: '2' }, {}] }),
    ])

    await expect(syncHandlers.gdrive_refresh_storage_quota({})).resolves.toEqual({
      connected: true,
      provider: 'gdrive',
      lastSync: 1_800_000_000,
      email: 'ada@example.com',
      storageUsed: 1000,
      storageTotal: 5000,
      storageAppUsed: 42,
    })
    expect(
      urls.some((url) => url.includes('/drive/v3/about') && url.includes('emailAddress')),
    ).toBe(true)
    const lists = urls.filter((url) => url.includes('/drive/v3/files'))
    expect(lists).toHaveLength(2)
    expect(lists.every((url) => url.includes('spaces=appDataFolder'))).toBe(true)
    expect(lists[1]).toContain('pageToken=p2')
    await expect(syncHandlers.gdrive_get_status({})).resolves.toMatchObject({
      connected: true,
      email: 'ada@example.com',
      storageUsed: 1000,
      storageTotal: 5000,
      storageAppUsed: 42,
    })
  })

  it('keeps the last good quota when about fails, and the last Memlore usage when the file sum fails', async () => {
    harness()
    await connect()
    scriptDrive(aboutOk('ada@example.com', '1000', '5000'), [
      Response.json({ files: [{ size: '42' }] }),
    ])
    await syncHandlers.gdrive_refresh_storage_quota({})

    scriptDrive(new Response('down', { status: 400 }), [])
    await expect(syncHandlers.gdrive_refresh_storage_quota({})).rejects.toThrow()
    await expect(syncHandlers.gdrive_get_status({})).resolves.toMatchObject({
      email: 'ada@example.com',
      storageUsed: 1000,
      storageTotal: 5000,
      storageAppUsed: 42,
    })

    scriptDrive(aboutOk('', '2000'), [new Response('list down', { status: 400 })])
    await expect(syncHandlers.gdrive_refresh_storage_quota({})).resolves.toEqual({
      connected: true,
      provider: 'gdrive',
      email: 'ada@example.com',
      storageUsed: 2000,
      storageTotal: 5000,
      storageAppUsed: 42,
    })
  })

  it('rejects when Drive is not connected and forgets the cached account', async () => {
    harness()
    await connect()
    scriptDrive(aboutOk('ada@example.com', '1000', '5000'), [
      Response.json({ files: [{ size: '42' }] }),
    ])
    await syncHandlers.gdrive_refresh_storage_quota({})

    vi.mocked(oauth.isConnected).mockReturnValue(false)
    await expect(syncHandlers.gdrive_refresh_storage_quota({})).rejects.toThrow(
      'Not connected to Google Drive',
    )
    await expect(syncHandlers.gdrive_get_status({})).resolves.toEqual({ connected: false })
  })
})

// ---------------------------------------------------------------------------------------------
// Push (Phase 16.5)
// ---------------------------------------------------------------------------------------------

async function draftManager(): Promise<DraftManager> {
  resetDraftsAutostartForTest()
  return createDraftManager({ db: await openWebDb({ factory: new IDBFactory() }) })
}

const PUSHED_ALL: PushResult = { pushed: 1, skipped: 0, pending: 0 }

describe('push triggers', () => {
  it('pushes once, PUSH_DEBOUNCE_MS after the last of several saves', async () => {
    const h = harness()
    h.flag = true
    const drafts = await draftManager()
    startSyncSchedule()
    await h.settle()
    expect(h.pushes).toBe(0)
    for (const id of ['a', 'b', 'c']) {
      await drafts.saveDraft(id, new Uint8Array([1]))
      await h.advance(PUSH_DEBOUNCE_MS / 2)
    }
    expect(h.pushes).toBe(0)
    await h.advance(PUSH_DEBOUNCE_MS / 2 - 1)
    expect(h.pushes).toBe(0)
    await h.advance(1)
    expect(h.pushes).toBe(1)
    await h.advance(PUSH_DEBOUNCE_MS * 5)
    expect(h.pushes).toBe(1)
  })

  it('never pushes while the cached write flag is off', async () => {
    const h = harness()
    h.pending = 2
    const drafts = await draftManager()
    startSyncSchedule()
    await h.settle()
    await drafts.saveDraft('a', new Uint8Array([1]))
    await h.advance(PUSH_DEBOUNCE_MS)
    h.setVisible('hidden')
    h.setVisible('visible')
    h.online()
    await syncHandlers.sync_now({})
    await h.settle()
    expect(h.pushes).toBe(0)
  })

  it('never pushes while locked, and a lock drops a pending debounced push', async () => {
    const h = harness()
    h.flag = true
    const drafts = await draftManager()
    startSyncSchedule()
    await h.settle()
    await drafts.saveDraft('a', new Uint8Array([1]))
    lock('manual')
    expect(h.timerCount()).toBe(0)
    await drafts.saveDraft('b', new Uint8Array([1]))
    h.online()
    await h.advance(PUSH_DEBOUNCE_MS * 2)
    expect(h.pushes).toBe(0)
  })

  it('pushes when the tab becomes visible and when the browser comes back online', async () => {
    const h = harness()
    h.flag = true
    startSyncSchedule()
    await h.settle()
    h.setVisible('hidden')
    await h.settle()
    expect(h.pushes).toBe(0)
    h.setVisible('visible')
    await h.settle()
    expect(h.pushes).toBe(1)
    h.online()
    await h.settle()
    expect(h.pushes).toBe(2)
  })

  it('pushes once after the unlock pull (hydration) when drafts are pending', async () => {
    const h = harness()
    h.flag = true
    h.pending = 2
    startSyncSchedule()
    await h.settle()
    expect(h.log).toEqual(['pull', 'push'])
  })

  it('pushes pending drafts after an interval pull (the flag may arrive after the unlock pull)', async () => {
    const h = harness()
    h.pending = 1
    startSyncSchedule()
    await h.settle()
    expect(h.log).toEqual(['pull'])
    h.flag = true
    h.pushResult = PUSHED_ALL
    await h.advance(INTERVAL_MS)
    expect(h.log).toEqual(['pull', 'pull', 'push'])
  })

  it('does not push after the unlock pull when nothing is pending', async () => {
    const h = harness()
    h.flag = true
    startSyncSchedule()
    await h.settle()
    expect(h.log).toEqual(['pull'])
  })

  it('installs its listeners once across restarts', async () => {
    const h = harness()
    h.flag = true
    const drafts = await draftManager()
    startSyncSchedule()
    startSyncSchedule()
    await h.settle()
    expect(h.listenerCount()).toBe(3)
    await drafts.saveDraft('a', new Uint8Array([1]))
    await h.advance(PUSH_DEBOUNCE_MS)
    expect(h.pushes).toBe(1)
    h.online()
    await h.settle()
    expect(h.pushes).toBe(2)
  })
})

describe('push status', () => {
  it('reports the unpushed draft count as entriesPending, 0 while locked', async () => {
    const h = harness()
    h.pending = 3
    await expect(syncHandlers.get_sync_status({})).resolves.toMatchObject({ entriesPending: 3 })
    lock('manual')
    await expect(syncHandlers.get_sync_status({})).resolves.toMatchObject({ entriesPending: 0 })
  })

  it('emits the status after a push changes entriesPending, without leaving synced', async () => {
    const h = harness()
    h.flag = true
    h.pending = 1
    h.pushResult = PUSHED_ALL
    startSyncSchedule()
    await h.settle()
    expect(h.states()).toEqual(['syncing', 'synced', 'synced'])
    expect(h.last()).toMatchObject({ state: 'synced', entriesPending: 0, error: null })
  })

  it('emits nothing after a push that leaves entriesPending unchanged', async () => {
    const h = harness()
    h.flag = true
    startSyncSchedule()
    await h.settle()
    h.online()
    await h.settle()
    expect(h.pushes).toBe(1)
    expect(h.states()).toEqual(['syncing', 'synced'])
  })

  it('sync_now pulls, then pushes, and reports what was pushed', async () => {
    const h = harness()
    h.flag = true
    h.pending = 1
    h.pushResult = PUSHED_ALL
    await expect(syncHandlers.sync_now({})).resolves.toEqual({
      pushed: 1,
      pulled: 0,
      merged: 0,
      errors: [],
    })
    expect(h.log).toEqual(['pull', 'push'])
    expect(h.last()).toMatchObject({ state: 'synced', entriesPending: 0, error: null })
  })

  it('sync_now pushes even when nothing is known to be pending', async () => {
    const h = harness()
    h.flag = true
    await syncHandlers.sync_now({})
    expect(h.log).toEqual(['pull', 'push'])
    expect(h.states()).toEqual(['syncing', 'synced'])
  })

  it('sync_now does not push after a failed pull', async () => {
    const h = harness()
    h.flag = true
    h.pending = 1
    h.queue(async () => {
      throw new Error('offline')
    })
    const summary = (await syncHandlers.sync_now({})) as { errors: string[] }
    expect(summary.errors).toEqual(['offline'])
    expect(h.pushes).toBe(0)
  })

  it('sync_now reports a push error in errors and ends in the error status', async () => {
    const h = harness()
    h.flag = true
    h.pending = 1
    h.pushResult = { pushed: 0, skipped: 0, pending: 1, error: new Error('Drive said no') }
    const summary = (await syncHandlers.sync_now({})) as { pushed: number; errors: string[] }
    expect(summary).toMatchObject({ pushed: 0, errors: ['Drive said no'] })
    expect(h.last()).toMatchObject({ state: 'error', error: 'Drive said no', entriesPending: 1 })
  })

  it('a push error is the error status and backs off like a failed pull', async () => {
    const h = harness()
    h.flag = true
    const drafts = await draftManager()
    h.pending = 1
    h.queuePush(async () => ({ pushed: 0, skipped: 0, pending: 1, error: new Error('quota') }))
    startSyncSchedule()
    await h.settle()
    expect(h.log).toEqual(['pull', 'push'])
    expect(h.last()).toMatchObject({ state: 'error', error: 'quota' })
    // Inside the backoff window: no automatic push, no pull on focus.
    await drafts.saveDraft('a', new Uint8Array([1]))
    await h.advance(PUSH_DEBOUNCE_MS)
    h.setVisible('hidden')
    h.setVisible('visible')
    await h.settle()
    expect(h.log).toEqual(['pull', 'push'])
    // The retry pushes again (a push has its own backoff, see the next test).
    h.pushResult = PUSHED_ALL
    await h.advance(BACKOFF_BASE_MS)
    expect(h.log).toEqual(['pull', 'push', 'push'])
    expect(h.last()).toMatchObject({ state: 'synced', error: null, entriesPending: 0 })
  })

  it('a re-onboard-required push error stops automatic pushes; pulls keep running', async () => {
    const h = harness()
    h.flag = true
    const drafts = await draftManager()
    h.pending = 1
    const message = 'Cannot push web edits: no cached vault state. Re-onboard this browser.'
    h.pushResult = {
      pushed: 0,
      skipped: 0,
      pending: 1,
      error: named('MissingVaultStateError', message),
    }
    startSyncSchedule()
    await h.settle()
    expect(h.log).toEqual(['pull', 'push'])
    expect(h.last()).toMatchObject({ state: 'error', error: message })
    // No retry timer, and no other automatic trigger pushes again.
    await h.advance(BACKOFF_BASE_MS * 64)
    await drafts.saveDraft('a', new Uint8Array([1]))
    await h.advance(PUSH_DEBOUNCE_MS)
    h.online()
    await h.settle()
    expect(h.log.filter((x) => x === 'push')).toHaveLength(1)
    expect(h.log.filter((x) => x === 'pull').length).toBeGreaterThan(1)
    // A new unlock (schedule restart) tries again.
    startSyncSchedule()
    await h.settle()
    expect(h.log.filter((x) => x === 'push')).toHaveLength(2)
  })

  it('a pull that latched the format guard shows the read-only note; no push, pulls go on', async () => {
    const h = harness()
    h.flag = true
    h.pending = 1
    h.outcome = { stale: [], changed: false, formatReadOnly: 'Unknown field(s) found: x' }
    startSyncSchedule()
    await h.settle()
    expect(h.log).toEqual(['pull'])
    expect(h.last()?.state).toBe('synced')
    expect(h.last()?.error).toContain(MSG_FORMAT_READ_ONLY)
    expect(h.last()?.error).toContain('Unknown field(s) found: x')
    const status = (await syncHandlers.get_sync_status({})) as { error?: string }
    expect(status.error).toContain(MSG_FORMAT_READ_ONLY)
    h.online()
    await h.advance(INTERVAL_MS)
    expect(h.log.filter((x) => x === 'push')).toHaveLength(0)
    expect(h.log.filter((x) => x === 'pull').length).toBeGreaterThan(1)
  })

  it('a format-guard push refusal shows the read-only message and stops automatic pushes', async () => {
    const h = harness()
    h.flag = true
    h.pending = 1
    h.pushResult = {
      pushed: 0,
      skipped: 0,
      pending: 1,
      error: named('FormatUnsupportedError', 'Format guard latched read-only: x'),
    }
    startSyncSchedule()
    await h.settle()
    expect(h.log).toEqual(['pull', 'push'])
    expect(h.last()?.state).toBe('error')
    expect(h.last()?.error).toContain(MSG_FORMAT_READ_ONLY)
    await h.advance(BACKOFF_BASE_MS * 64)
    h.online()
    await h.settle()
    expect(h.log.filter((x) => x === 'push')).toHaveLength(1)
  })

  it('pushes pending drafts when the write flag arrives after the unlock pull', async () => {
    const h = harness()
    h.pending = 1
    startSyncSchedule()
    await h.settle()
    expect(h.log).toEqual(['pull'])
    h.pushResult = PUSHED_ALL
    h.flagOn()
    await h.settle()
    expect(h.log).toEqual(['pull', 'push'])
    // Nothing pending: the flag turning on does not push.
    stopSyncSchedule()
    h.flag = false
    startSyncSchedule()
    await h.settle()
    h.flagOn()
    await h.settle()
    expect(h.log).toEqual(['pull', 'push', 'pull'])
  })

  it('reports a run that several triggers joined once', async () => {
    const h = harness()
    h.flag = true
    startSyncSchedule()
    await h.settle()
    // pushAll hands every joiner of a run the same result object.
    let release!: (r: PushResult) => void
    const shared = new Promise<PushResult>((resolve) => (release = resolve))
    h.pushImpl = () => shared
    h.online()
    h.online()
    await h.settle()
    const before = h.events.length
    release({ pushed: 0, skipped: 0, pending: 1, error: new Error('quota') })
    await h.settle()
    expect(h.events).toHaveLength(before + 1)
    expect(h.last()).toMatchObject({ state: 'error', error: 'quota' })
    // One failure: the retry lands after the first backoff step, not the second.
    h.pushImpl = async () => PUSHED_ALL
    await h.advance(BACKOFF_BASE_MS)
    expect(h.last()).toMatchObject({ state: 'synced', error: null })
  })

  it('a second push failure doubles the backoff', async () => {
    const h = harness()
    h.flag = true
    h.pending = 1
    h.pushResult = { pushed: 0, skipped: 0, pending: 1, error: new Error('quota') }
    startSyncSchedule()
    await h.settle()
    await h.advance(BACKOFF_BASE_MS)
    expect(h.pushes).toBe(2)
    await h.advance(BACKOFF_BASE_MS * 2 - 1)
    expect(h.pushes).toBe(2)
    await h.advance(1)
    expect(h.pushes).toBe(3)
  })

  it('a failing push does not block pulls, and a clean pull keeps the push error', async () => {
    const h = harness()
    h.flag = true
    h.pending = 1
    h.pushResult = { pushed: 0, skipped: 0, pending: 1, error: new Error('quota') }
    startSyncSchedule()
    await h.settle()
    await h.advance(FOCUS_MIN_AGE_MS + 1)
    h.focus()
    await h.settle()
    expect(h.pulls).toBe(2)
    expect(h.last()).toMatchObject({ state: 'error', error: 'quota' })
  })

  it('clears a push error once a later push succeeds', async () => {
    const h = harness()
    h.flag = true
    h.pending = 1
    h.queuePush(async () => ({ pushed: 0, skipped: 0, pending: 1, error: new Error('quota') }))
    startSyncSchedule()
    await h.settle()
    expect(h.last()?.state).toBe('error')
    h.pushResult = PUSHED_ALL
    h.online()
    await h.settle()
    expect(h.last()).toMatchObject({ state: 'synced', error: null, entriesPending: 0 })
  })

  it('a successful push does not hide a pull error', async () => {
    const h = harness()
    h.flag = true
    h.queue(async () => {
      throw new Error('offline')
    })
    startSyncSchedule()
    await h.settle()
    h.online()
    await h.settle()
    expect(h.pushes).toBe(1)
    expect(h.last()).toMatchObject({ state: 'error', error: 'offline' })
  })

  it('ignores the report of a push that finishes after the lock', async () => {
    const h = harness()
    h.flag = true
    let release!: (r: PushResult) => void
    h.queuePush(() => new Promise<PushResult>((resolve) => (release = resolve)))
    startSyncSchedule()
    await h.settle()
    h.online()
    await h.settle()
    lock('manual')
    const before = h.events.length
    release({ pushed: 0, skipped: 0, pending: 1, error: new Error('late') })
    await h.settle()
    expect(h.events).toHaveLength(before)
  })
})
