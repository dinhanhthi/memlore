import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'

import {
  SYNC_SCOPE_UPGRADE_EVENT,
  clearSyncScopeUpgradeRequired,
  getSyncScopeUpgradeRequired,
} from '../lib/tauri'

/**
 * Surfaces the drive.file → drive.appdata reconnect banner.
 *
 * The flag lives in the backend `settings` table and is set the first
 * time `run_sync_now` sees a legacy-scope token. The frontend reads it
 * on mount and re-reads it whenever the backend emits
 * `sync:scope-upgrade-required` (the banner stays in sync even if the
 * Settings panel was already open when the auto-disconnect fired).
 */
export function useScopeUpgradeBanner() {
  const [required, setRequired] = useState(false)

  useEffect(() => {
    let cancelled = false

    void getSyncScopeUpgradeRequired().then((v) => {
      if (!cancelled) setRequired(v)
    })

    const unlistenPromise = listen(SYNC_SCOPE_UPGRADE_EVENT, () => {
      if (!cancelled) setRequired(true)
    })

    return () => {
      cancelled = true
      void unlistenPromise.then((un) => un())
    }
  }, [])

  const dismiss = async () => {
    await clearSyncScopeUpgradeRequired()
    setRequired(false)
  }

  return { required, dismiss }
}
