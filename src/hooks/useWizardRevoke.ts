import { useCallback, useRef, useState } from 'react'
import { errMsg } from '../lib/errMsg'
import * as tauri from '../lib/tauri'
import { useSyncStore } from '../stores/syncStore'
import { useUiStore } from '../stores/uiStore'

const GENERIC_ERROR_KEY = 'settings:security.secure_wizard.errors.generic'
const SYNC_IN_PROGRESS_ERROR_KEY = 'settings:security.secure_wizard.errors.sync_in_progress'
const SYNC_IN_PROGRESS_ERR = 'sync_in_progress'
let activeRunOwner: symbol | null = null

export type WizardRevokeStatus = 'idle' | 'running' | 'done' | 'error'

export interface WizardRevokeArgs {
  deviceId: string
  password: string
  phrase: string
}

interface UseWizardRevokeReturn {
  status: WizardRevokeStatus
  errorKey: string | null
  run: (args: WizardRevokeArgs) => Promise<void>
}

export function useWizardRevoke(): UseWizardRevokeReturn {
  const [status, setStatus] = useState<WizardRevokeStatus>('idle')
  const [errorKey, setErrorKey] = useState<string | null>(null)
  const runningRef = useRef(false)

  const run = useCallback(async ({ deviceId, password, phrase }: WizardRevokeArgs) => {
    const uiStore = useUiStore.getState()
    if (runningRef.current || activeRunOwner !== null || uiStore.rotationBusy) return

    const runOwner = Symbol('wizard-revoke-run')
    activeRunOwner = runOwner
    runningRef.current = true
    setStatus('running')
    setErrorKey(null)
    uiStore.setRotationBusy(true)

    try {
      try {
        await tauri.revokeDevice(deviceId, password, phrase)
      } catch (error) {
        setStatus('error')
        setErrorKey(
          errMsg(error) === SYNC_IN_PROGRESS_ERR ? SYNC_IN_PROGRESS_ERROR_KEY : GENERIC_ERROR_KEY,
        )
        return
      }

      try {
        await useSyncStore.getState().refresh()
      } catch {
        // The revoke mutation already succeeded; stale sync UI is recoverable.
      }
      try {
        await tauri.refreshDevicesFromCloud()
      } catch {
        // Mounted device lists get one more best-effort refresh via the event.
      }
      window.dispatchEvent(new CustomEvent('memlore:devices-changed'))
      setStatus('done')
    } finally {
      runningRef.current = false
      if (activeRunOwner === runOwner) {
        activeRunOwner = null
        useUiStore.getState().setRotationBusy(false)
      }
    }
  }, [])

  return { status, errorKey, run }
}
