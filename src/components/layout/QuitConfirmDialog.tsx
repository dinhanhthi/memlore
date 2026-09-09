import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { REQUEST_QUIT_EVENT } from '../../lib/requestCloseActiveTab'

/**
 * Confirms app quit when the user tries to close the last open tab (⌘W /
 * Window → Close Tab). Listens for `memlore:request-quit` from
 * `requestCloseActiveTab`. Mount at the App root so it works on the lock
 * screen and other non-shell states where tab shortcuts still run.
 */
export function QuitConfirmDialog() {
  const { t } = useTranslation('nav')
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onRequestQuit = () => setOpen(true)
    window.addEventListener(REQUEST_QUIT_EVENT, onRequestQuit)
    return () => window.removeEventListener(REQUEST_QUIT_EVENT, onRequestQuit)
  }, [])

  return (
    <ConfirmDialog
      open={open}
      title={t('titlebar.quit_confirm.title')}
      description={t('titlebar.quit_confirm.description')}
      confirmLabel={t('titlebar.quit_confirm.confirm')}
      onConfirm={() => {
        void getCurrentWindow()
          .close()
          .catch((err: unknown) => {
            if (import.meta.env.DEV) {
              console.warn('[QuitConfirmDialog] window.close() rejected:', err)
            }
          })
      }}
      onClose={() => setOpen(false)}
    />
  )
}
