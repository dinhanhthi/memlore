import { useSyncExternalStore } from 'react'
import { getSetting, setSetting } from '../lib/tauri'

export type CreateSettingHookOptions<T> = {
  key: string
  defaultValue: T
  parse: (raw: string | null) => T
  /** Defaults to `'true'`/`'false'` for booleans, otherwise `String(value)`. */
  serialize?: (value: T) => string
  /** Prefix for hydrate-error logs: `[logLabel] failed to hydrate ${key}:`. */
  logLabel: string
  /** Runs after the value is applied on set, before notify. */
  onSet?: (next: T) => void
  /**
   * Skip applying a hydrate result when a user write raced the in-flight
   * `getSetting` (seq changed during the await) or a persist is in-flight.
   * Does not skip hydrates after persist has settled.
   */
  ignoreHydrateAfterUserWrite?: boolean
}

export type SettingHook<T> = {
  hydrate: () => Promise<void>
  isHydrated: () => boolean
  useValue: () => T
  useHydrated: () => boolean
  get: () => T
  setValue: (next: T) => Promise<void>
  reset: () => void
}

function defaultSerialize<T>(value: T): string {
  return typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value)
}

/**
 * Module-level SQLite-backed setting store with useSyncExternalStore
 * subscriptions (hydrate / get / set / reset).
 */
export function createSettingHook<T>(options: CreateSettingHookOptions<T>): SettingHook<T> {
  const { key, defaultValue, parse, logLabel, onSet, ignoreHydrateAfterUserWrite = false } = options
  const serialize = options.serialize ?? defaultSerialize

  let value = defaultValue
  let loaded = false
  let userWriteSeq = 0
  let persistInFlight = false
  let persistGeneration = 0
  let lastPersistedSeq = 0
  let lastPersistedValue = defaultValue
  let persistChain: Promise<void> = Promise.resolve()
  const listeners = new Set<() => void>()

  function notify(): void {
    for (const listener of listeners) listener()
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  function getValueSnapshot(): T {
    return value
  }

  function getHydratedSnapshot(): boolean {
    return loaded
  }

  function shouldSkipHydrate(seqAtStart: number, persistGenAtStart: number): boolean {
    if (!ignoreHydrateAfterUserWrite) return false
    return (
      userWriteSeq !== seqAtStart ||
      persistInFlight ||
      persistGeneration !== persistGenAtStart ||
      lastPersistedSeq < userWriteSeq
    )
  }

  async function persistUntilCaughtUp(): Promise<void> {
    persistInFlight = true
    try {
      while (lastPersistedSeq < userWriteSeq) {
        const seq = userWriteSeq
        const snapshot = value
        await setSetting(key, serialize(snapshot))
        lastPersistedSeq = seq
        lastPersistedValue = snapshot
        if (userWriteSeq === seq) return
      }
    } finally {
      persistInFlight = false
      persistGeneration++
    }
  }

  function enqueuePersist(): Promise<void> {
    const run = persistChain.then(() => persistUntilCaughtUp())
    persistChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async function hydrate(): Promise<void> {
    const seqAtStart = userWriteSeq
    const persistGenAtStart = persistGeneration
    try {
      const stored = await getSetting(key)
      if (shouldSkipHydrate(seqAtStart, persistGenAtStart)) return
      value = parse(stored)
      loaded = true
      notify()
    } catch (err) {
      if (import.meta.env.MODE !== 'test') {
        console.error(`[${logLabel}] failed to hydrate ${key}:`, err)
      }
      // Fail open to the default so callers are not blocked forever on a
      // transient get_setting error after unlock. Keep an already-loaded
      // value (user write or prior hydrate) instead of clobbering it.
      if (shouldSkipHydrate(seqAtStart, persistGenAtStart) || loaded) return
      value = defaultValue
      loaded = true
      notify()
    }
  }

  function isHydrated(): boolean {
    return loaded
  }

  function useValue(): T {
    return useSyncExternalStore(subscribe, getValueSnapshot, getValueSnapshot)
  }

  function useHydrated(): boolean {
    return useSyncExternalStore(subscribe, getHydratedSnapshot, getHydratedSnapshot)
  }

  function get(): T {
    return value
  }

  async function setValue(next: T): Promise<void> {
    if (ignoreHydrateAfterUserWrite) {
      userWriteSeq++
      const seq = userWriteSeq
      value = next
      loaded = true
      notify()
      try {
        await enqueuePersist()
        if (userWriteSeq === seq) {
          onSet?.(next)
        }
      } catch (err) {
        if (userWriteSeq === seq) {
          value = lastPersistedValue
          lastPersistedSeq = userWriteSeq
          notify()
        }
        throw err
      }
      return
    }
    await setSetting(key, serialize(next))
    value = next
    loaded = true
    onSet?.(next)
    notify()
  }

  function reset(): void {
    value = defaultValue
    loaded = false
    userWriteSeq = 0
    persistInFlight = false
    persistGeneration = 0
    lastPersistedSeq = 0
    lastPersistedValue = defaultValue
    persistChain = Promise.resolve()
    listeners.clear()
  }

  return { hydrate, isHydrated, useValue, useHydrated, get, setValue, reset }
}
