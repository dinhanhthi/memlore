import { useCallback, useState } from 'react'
import { save } from '@tauri-apps/plugin-dialog'
import { exportStatsFile, renderRecoverySheet } from '../lib/tauri'

/** Suggested file name in the save dialog. Not localised — it is a file name. */
export const RECOVERY_SHEET_FILE_NAME = 'memlore-recovery-sheet.pdf'

/**
 * Outcome of one "download the recovery sheet" attempt.
 *
 * `cancelled` is a first-class, non-error outcome: dismissing the native save
 * dialog is a normal choice (the sheet is optional), so the UI must not show
 * a failure for it.
 */
export type RecoverySheetStatus =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; path: string }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string }

export interface UseRecoverySheet {
  status: RecoverySheetStatus
  /**
   * Render the sheet for `mnemonic` (the 24 words) and write it wherever the
   * user points the save dialog. Never writes to a default path.
   */
  saveSheet: (mnemonic: string[]) => Promise<RecoverySheetStatus>
}

/**
 * `useRecoverySheet` — the optional recovery-sheet download.
 *
 * Rendering happens **before** the save dialog opens so an invalid phrase
 * fails without first asking the user to pick a destination.
 *
 * The bytes are written through `export_stats_file`, the app's universal
 * byte sink for save-dialog paths (see its Rust module docstring). Reusing it
 * is deliberate: it keeps `tauri-plugin-fs` out of the bundle and the
 * frontend's filesystem permission surface at zero.
 */
export function useRecoverySheet(): UseRecoverySheet {
  const [status, setStatus] = useState<RecoverySheetStatus>({ kind: 'idle' })

  const saveSheet = useCallback(async (mnemonic: string[]): Promise<RecoverySheetStatus> => {
    setStatus({ kind: 'saving' })
    try {
      const bytes = await renderRecoverySheet(mnemonic.join(' '))

      const path = await save({
        defaultPath: RECOVERY_SHEET_FILE_NAME,
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      })
      // The dialog resolves to `null` (and, defensively, `undefined`) when the
      // user dismisses it — matches the check in ExportStatsModal.
      if (typeof path !== 'string') {
        const cancelled: RecoverySheetStatus = { kind: 'cancelled' }
        setStatus(cancelled)
        return cancelled
      }

      await exportStatsFile(path, bytes)
      const saved: RecoverySheetStatus = { kind: 'saved', path }
      setStatus(saved)
      return saved
    } catch (err) {
      // Tauri rejects with plain strings, not Error objects — handle both.
      const message =
        typeof err === 'string'
          ? err
          : err instanceof Error
            ? err.message
            : 'Failed to save the recovery sheet'
      const failed: RecoverySheetStatus = { kind: 'error', message }
      setStatus(failed)
      return failed
    }
  }, [])

  return { status, saveSheet }
}
