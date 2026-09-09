import { useCallback, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { decodeRecoveryQrFile, onboardValidatePassphrase } from '../lib/tauri'

/** File types offered in the open dialog. The realistic input is the recovery
 *  sheet PDF the user downloaded (the QR is extracted from it directly), but a
 *  screenshot or phone photo of a printed sheet is also accepted. */
export const RECOVERY_QR_FILE_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']

/**
 * Outcome of one "import the recovery sheet's QR" attempt.
 *
 * `cancelled` is a first-class, non-error outcome: dismissing the native open
 * dialog is a normal choice (typing the words is always available), so the UI
 * must not show a failure for it.
 */
export type RecoveryQrImportStatus =
  | { kind: 'idle' }
  | { kind: 'importing' }
  | { kind: 'imported'; mnemonic: string }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string }

export interface UseRecoveryQrImport {
  status: RecoveryQrImportStatus
  /**
   * Ask for an image file, decode the QR in it, and validate the phrase against
   * the cloud vault. Resolves with the same status it stores.
   */
  importFromImage: () => Promise<RecoveryQrImportStatus>
  /** Drop any error/cancelled state (e.g. the user started typing instead). */
  reset: () => void
}

/**
 * `useRecoveryQrImport` — the second way into the join flow: instead of typing
 * the 24 words, point at the recovery sheet's QR image.
 *
 * Two backend calls, in this order, and the second one is not optional:
 *
 * 1. `decode_recovery_qr_file` reads the picked file and pulls the phrase out
 *    of the QR. It proves BIP39 syntax **only** — a QR from a different vault's
 *    sheet decodes perfectly well.
 * 2. `onboard_validate_passphrase` is the real check, against the cloud
 *    keyring's fingerprint. It is the exact call the typed path makes, so the
 *    QR route is not a weaker second door into the vault.
 *
 * The read happens in Rust because the app ships no `tauri-plugin-fs` — see
 * `decodeRecoveryQrFile` in `lib/tauri.ts` for why a path-in/phrase-out command
 * is preferred over a generic file reader.
 *
 * @param sessionId Drive OAuth session id, forwarded to the validation call
 *        exactly like the typed path does (the backend peeks the pending
 *        session so the cloud read works before any token is persisted).
 */
export function useRecoveryQrImport(sessionId?: string): UseRecoveryQrImport {
  const [status, setStatus] = useState<RecoveryQrImportStatus>({ kind: 'idle' })

  const reset = useCallback(() => setStatus({ kind: 'idle' }), [])

  const importFromImage = useCallback(async (): Promise<RecoveryQrImportStatus> => {
    setStatus({ kind: 'importing' })
    try {
      const path = await open({
        multiple: false,
        directory: false,
        filters: [{ name: 'Recovery sheet or image', extensions: RECOVERY_QR_FILE_EXTENSIONS }],
      })
      // The dialog resolves to `null` (and, defensively, `undefined`) when the
      // user dismisses it — matches the check in ImportModal.
      if (typeof path !== 'string') {
        const cancelled: RecoveryQrImportStatus = { kind: 'cancelled' }
        setStatus(cancelled)
        return cancelled
      }

      const mnemonic = await decodeRecoveryQrFile(path)
      await onboardValidatePassphrase(mnemonic, sessionId)

      const imported: RecoveryQrImportStatus = { kind: 'imported', mnemonic }
      setStatus(imported)
      return imported
    } catch (err) {
      // Tauri rejects with plain strings, not Error objects — handle both.
      const message =
        typeof err === 'string'
          ? err
          : err instanceof Error
            ? err.message
            : 'Could not read a recovery phrase from that file'
      const failed: RecoveryQrImportStatus = { kind: 'error', message }
      setStatus(failed)
      return failed
    }
  }, [sessionId])

  return { status, importFromImage, reset }
}
