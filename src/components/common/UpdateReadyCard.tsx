import { RotateCw, Sparkles } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from './Button'
import { toast } from '../../lib/toast'
import { useUpdater } from '../../hooks/useUpdater'

/** Long enough for a user who was mid-sentence when the background install
 *  gave up to still read it. Matches `OnDeviceLlmErrorToaster`. */
const ERROR_TOAST_DURATION_MS = 6000

/**
 * The post-install half of the updater UI — everything that happens *after*
 * the user pressed "Update now" and went back to work.
 *
 * - `ready-to-restart`: a persistent bottom-right card offering Restart or
 *   Later. Deliberately not a `toast()`: that helper has no action buttons and
 *   auto-fades, and a restart prompt that vanishes on its own is useless.
 *   Nothing is forced — the new build is already on disk, so "Later" costs the
 *   user nothing, and the card says so.
 * - `install-failed`: a toast, because a background failure must not take over
 *   a session the user never interrupted. Cleared immediately after so it
 *   fires once.
 *
 * Mounted once in the app shell, next to the other global surfaces.
 */
export function UpdateReadyCard() {
  const { t } = useTranslation('common')
  const { status, update, restart, dismiss } = useUpdater()
  const toastedRef = useRef(false)

  useEffect(() => {
    if (status !== 'install-failed') {
      toastedRef.current = false
      return
    }
    if (toastedRef.current) return
    toastedRef.current = true
    toast(t('updater.install_failed_body'), {
      position: 'bottom-right',
      duration: ERROR_TOAST_DURATION_MS,
    })
    // The state machine's only job here was to carry the failure across; the
    // toast now owns it, and leaving the status set would re-fire on remount.
    dismiss()
  }, [status, t, dismiss])

  if (status !== 'ready-to-restart') return null

  return (
    // Below the modal layer (z-1000) on purpose: a modal the user opened is
    // more urgent than a restart they already deferred once.
    <div
      role="status"
      className="border-border-default bg-elevated fixed right-8 bottom-8 z-40 w-80 rounded-2xl border p-4 shadow-(--elev-4)"
    >
      <div className="flex items-start gap-2">
        <Sparkles className="text-accent mt-0.5 size-4 shrink-0" strokeWidth={1.75} />
        <div className="min-w-0 space-y-1">
          <p className="text-fg text-sm font-semibold">
            {t('updater.ready')}{' '}
            {/* Shown only when known — the version comes from the check that
                preceded the install, which is always there in practice. */}
            {update != null && <span className="text-fg-muted font-normal">{update.version}</span>}
          </p>
          <p className="text-fg-secondary text-xs leading-relaxed">{t('updater.ready_body')}</p>
        </div>
      </div>

      <div className="mt-3 flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={dismiss}>
          {t('updater.later')}
        </Button>
        <Button variant="primary" size="sm" onClick={() => void restart()}>
          <RotateCw className="size-4" strokeWidth={1.75} />
          {t('updater.restart')}
        </Button>
      </div>
    </div>
  )
}
