import { useCallback, useEffect, useState } from 'react'
import { getSetting, setSetting } from '../lib/tauri'

export const WEB_AUTO_LOCK_OPTIONS = ['1', '5', '15', '30'] as const
export type WebAutoLockMinutes = (typeof WEB_AUTO_LOCK_OPTIONS)[number]

const KEY = 'web_auto_lock_minutes'
const DEFAULT: WebAutoLockMinutes = '15'

const isOption = (value: unknown): value is WebAutoLockMinutes =>
  (WEB_AUTO_LOCK_OPTIONS as readonly unknown[]).includes(value)

export interface UseWebAutoLockResult {
  minutes: WebAutoLockMinutes
  setMinutes: (minutes: WebAutoLockMinutes) => Promise<void>
}

/**
 * Web only: idle auto-lock minutes for this browser (Settings → General). The
 * web backend stores it in IndexedDB and applies it at once and after each
 * unlock; unset, unknown or unreadable shows the backend's 15 min default.
 */
export function useWebAutoLock(): UseWebAutoLockResult {
  const [minutes, setMinutesState] = useState<WebAutoLockMinutes>(DEFAULT)

  useEffect(() => {
    let cancelled = false
    getSetting(KEY)
      .then((value) => {
        if (!cancelled && isOption(value)) setMinutesState(value)
      })
      .catch(() => {
        // Keep the default the backend also falls back to.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const setMinutes = useCallback(async (value: WebAutoLockMinutes): Promise<void> => {
    await setSetting(KEY, value)
    setMinutesState(value)
  }, [])

  return { minutes, setMinutes }
}
