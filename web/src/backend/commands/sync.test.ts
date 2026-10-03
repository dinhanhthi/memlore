import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dispose, lock, setKeyRing, type KeyRing } from '../keys'
import type { PullOutcome } from './readSession'
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  FOCUS_MIN_AGE_MS,
  INTERVAL_MS,
  MSG_FORMAT_READ_ONLY,
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
  const h = {
    pulls: 0,
    outcome: NOOP,
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
    pull: async () => {
      h.pulls += 1
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
