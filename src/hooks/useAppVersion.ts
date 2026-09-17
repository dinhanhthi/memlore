import { invoke } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'

/**
 * The running build's version (`app_version` in
 * `src-tauri/src/commands/updater.rs`), for the About page.
 *
 * `null` until it resolves, and permanently `null` where the command is not
 * answered — the web harness / website demo route unknown commands to `null`.
 * Callers render nothing in that case rather than a wrong version.
 */
export function useAppVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    invoke<string | null>('app_version')
      .then((v) => {
        if (alive && typeof v === 'string' && v !== '') setVersion(v)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  return version
}
