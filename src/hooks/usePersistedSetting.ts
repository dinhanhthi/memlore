import { useCallback, useEffect, useState } from 'react'
import { getSetting, setSetting } from '../lib/tauri'

function defaultSerialize<T>(value: T): string {
  return typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value)
}

export type UsePersistedSettingOptions<T, R = void> = {
  key: string
  defaultValue: T
  parse: (raw: string | null | undefined) => T
  serialize?: (value: T) => string
  persist?: (next: T) => Promise<R>
  /** After a successful mount `getSetting` parse. */
  onLoad?: (parsed: T) => void
  /** After a successful persist; not called on rollback. */
  onPersist?: (next: T) => void
}

/**
 * Per-mount SQLite setting: local state, `loading` until the first
 * `getSetting` settles, optimistic persist with rollback + rethrow.
 * Distinct from `createSettingHook`'s process-wide store.
 */
export function usePersistedSetting<T, R = void>(
  options: UsePersistedSettingOptions<T, R>,
): {
  value: T
  loading: boolean
  setValue: (next: T) => Promise<R>
} {
  const { key, defaultValue, parse, onLoad, onPersist } = options
  const serialize = options.serialize ?? defaultSerialize<T>
  const persist = options.persist ?? ((next: T) => setSetting(key, serialize(next)) as Promise<R>)

  const [value, setValueState] = useState(defaultValue)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void getSetting(key)
      .then((raw) => {
        if (cancelled) return
        const parsed = parse(raw)
        setValueState(parsed)
        onLoad?.(parsed)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // Mount-only read; parse/onLoad are per-call-site constants.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setValue = useCallback(
    async (next: T) => {
      const prev = value
      setValueState(next)
      try {
        const result = await persist(next)
        onPersist?.(next)
        return result
      } catch (e) {
        // Roll back so the UI doesn't claim a state the database can't confirm.
        setValueState(prev)
        throw e
      }
    },
    // value is the rollback snapshot; persist/onPersist are per-call-site constants.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [value],
  )

  return { value, loading, setValue }
}
