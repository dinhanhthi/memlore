import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { uninstallApp, uninstallPreview, type UninstallPreview } from '../lib/tauri'

/**
 * How long to wait for the app to disappear after `run()` before assuming exit
 * stalled. The backend spawns the reaper and calls `app.exit(0)` immediately,
 * so a healthy uninstall tears the webview down well inside this window.
 */
const STALL_TIMEOUT_MS = 10_000

export interface UninstallState {
  preview: UninstallPreview | null
  loading: boolean
  /** `run()` is in flight. Never clears on the happy path — the app exits. */
  running: boolean
  /** The app failed to quit within {@link STALL_TIMEOUT_MS}. The UI must
   *  re-enable its escape hatches rather than trap the user in the dialog. */
  stalled: boolean
  error: string | null
  load: () => Promise<void>
  run: (removeAppBundle: boolean) => Promise<void>
}

/**
 * Backing state for Settings → General → Danger zone.
 *
 * `preview` is fetched lazily via `load()` (the caller opens the modal) rather
 * than on mount — it walks the whole app-data tree to size it, which is wasted
 * work for every user who never opens the dialog.
 *
 * `run()` deliberately never resolves in the happy path: the backend calls
 * `app.exit(0)`, so the webview tears down mid-promise. Callers must therefore
 * treat "still running" as success — with `stalled` as the escape hatch for
 * the case where the process does not actually go away.
 */
export function useUninstall(): UninstallState {
  const [preview, setPreview] = useState<UninstallPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [stalled, setStalled] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  const stallTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      clearTimeout(stallTimer.current)
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const next = await uninstallPreview()
      if (mounted.current) setPreview(next)
    } catch (e) {
      if (mounted.current) setError(String(e))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])

  const run = useCallback(async (removeAppBundle: boolean) => {
    setRunning(true)
    setStalled(false)
    setError(null)
    stallTimer.current = window.setTimeout(() => {
      if (mounted.current) setStalled(true)
    }, STALL_TIMEOUT_MS)
    try {
      await uninstallApp(removeAppBundle)
    } catch (e) {
      // Reachable only when the backend refused before spawning the reaper —
      // including the user dismissing the native OS confirmation dialog.
      clearTimeout(stallTimer.current)
      if (mounted.current) {
        setError(String(e))
        setRunning(false)
        setStalled(false)
      }
    }
  }, [])

  return useMemo(
    () => ({ preview, loading, running, stalled, error, load, run }),
    [preview, loading, running, stalled, error, load, run],
  )
}
