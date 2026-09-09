import { useCallback, useRef, useState } from 'react'
import * as tauri from '../lib/tauri'
import { useUiStore } from '../stores/uiStore'

const GENERIC_ERROR_KEY = 'settings:security.secure_wizard.errors.generic'

export type WizardRemoveStatus = 'idle' | 'running' | 'done' | 'error'

interface UseWizardRemoveReturn {
  status: WizardRemoveStatus
  errorKey: string | null
  run: (deviceId: string) => Promise<void>
}

/**
 * `useWizardRemove` — the no-security sibling of `useWizardRevoke`.
 *
 * Removes a peer device from the registry (cloud slot + local row) without
 * rotating any keys, then best-effort refreshes the device list. The frontend
 * `rotationBusy` flag is not set (nothing rotates); instead the run flips
 * `uiStore.deviceRemovalBusy` so the footer keeps a "removing" indicator even
 * after the wizard modal closes — the flow is non-blocking and the backend
 * command queues behind an in-flight sync (`SyncInProgressGuard::
 * acquire_waiting`), which can take minutes. This async fn keeps executing
 * after the calling component unmounts: the local setState calls become
 * no-ops, but the store update and `memlore:devices-changed` dispatch still
 * land, so background completion stays visible app-wide. Settle also writes
 * `deviceRemovalOutcome` (`ok` / `error`) so Settings → Sync → Devices can
 * show a dismissible notice when the wizard is already gone.
 */
export function useWizardRemove(): UseWizardRemoveReturn {
  const [status, setStatus] = useState<WizardRemoveStatus>('idle')
  const [errorKey, setErrorKey] = useState<string | null>(null)
  const runningRef = useRef(false)

  const run = useCallback(async (deviceId: string) => {
    if (runningRef.current) return

    runningRef.current = true
    setStatus('running')
    setErrorKey(null)
    // MUST stay before the first await: the wizard's Remove buttons disable
    // off this flag, so setting it synchronously is what closes the
    // double-fire window across hook instances.
    useUiStore.getState().setDeviceRemovalBusy(true)
    useUiStore.getState().setDeviceRemovalOutcome(null)

    try {
      try {
        await tauri.removeDevice(deviceId)
      } catch {
        setStatus('error')
        setErrorKey(GENERIC_ERROR_KEY)
        useUiStore.getState().setDeviceRemovalOutcome('error')
        return
      }

      try {
        await tauri.refreshDevicesFromCloud()
      } catch {
        // The removal already succeeded; mounted device lists get one more
        // best-effort refresh via the event below.
      }
      window.dispatchEvent(new CustomEvent('memlore:devices-changed'))
      setStatus('done')
      useUiStore.getState().setDeviceRemovalOutcome('ok')
    } finally {
      runningRef.current = false
      useUiStore.getState().setDeviceRemovalBusy(false)
    }
  }, [])

  return { status, errorKey, run }
}
