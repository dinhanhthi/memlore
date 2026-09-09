import { useCallback } from 'react'
import { open } from '@tauri-apps/plugin-dialog'

/**
 * Native directory picker. Components must call this hook instead of importing
 * `@tauri-apps/plugin-dialog` themselves.
 *
 * Resolves to the chosen path, or `null` when the user dismisses the dialog
 * (`open` also returns `undefined` in some plugin versions — treat both as cancel).
 */
export function usePickFolder(): () => Promise<string | null> {
  return useCallback(async () => {
    const selected = await open({ directory: true, multiple: false })
    return typeof selected === 'string' ? selected : null
  }, [])
}
