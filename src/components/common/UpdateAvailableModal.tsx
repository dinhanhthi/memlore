import { AlertTriangle, ArrowDownToLine, CheckCircle2, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from './Button'
import { Modal } from './Modal'
import { useUpdater, type UpdaterStatus } from '../../hooks/useUpdater'

const TITLE_KEY: Record<Exclude<UpdaterStatus, 'idle'>, string> = {
  checking: 'updater.checking',
  available: 'updater.available',
  downloading: 'updater.available',
  'up-to-date': 'updater.up_to_date',
  error: 'updater.failed',
  'install-failed': 'updater.install_failed',
}

/**
 * The only UI of the updater state machine (`useUpdater`): it opens itself
 * whenever the shared status leaves `idle`. The silent startup check only
 * leaves `idle` when it actually found something, so this stays invisible at
 * boot; the `Check For Updates…` menu item drives the checking / up-to-date /
 * error states too.
 */
export function UpdateAvailableModal() {
  const { t } = useTranslation('common')
  const { status, update, error, install, dismiss } = useUpdater()

  if (status === 'idle') return null

  // Installing is non-dismissable: the app is being swapped under us and will
  // restart. Checking stays closable — it can take up to the backend's 30s
  // timeout, and a modal the user cannot escape would be worse than a late
  // result (which `useUpdater` drops once this closes). No progress events
  // exist (the backend installs with empty progress callbacks), so the
  // download is indeterminate.
  const busy = status === 'downloading'

  return (
    <Modal onClose={busy ? () => {} : dismiss} disableEsc={busy} disableBackdrop={busy}>
      <Modal.Header>{t(TITLE_KEY[status])}</Modal.Header>

      <Modal.Body fitContent className="space-y-3">
        {status === 'checking' && (
          <p className="text-fg-secondary text-sm">{t('updater.checking_body')}</p>
        )}

        {status === 'up-to-date' && (
          <p className="text-fg-secondary flex items-start gap-2 text-sm">
            <CheckCircle2 className="text-accent mt-0.5 size-4 shrink-0" strokeWidth={1.75} />
            <span>{t('updater.up_to_date_body')}</span>
          </p>
        )}

        {(status === 'error' || status === 'install-failed') && (
          <div className="space-y-2">
            <p className="text-fg-secondary flex items-start gap-2 text-sm">
              <AlertTriangle className="text-fg-muted mt-0.5 size-4 shrink-0" strokeWidth={1.75} />
              <span>
                {t(
                  status === 'install-failed'
                    ? 'updater.install_failed_body'
                    : 'updater.failed_body',
                )}
              </span>
            </p>
            {error != null && (
              <p className="text-fg-muted font-mono text-xs break-words">{error}</p>
            )}
          </div>
        )}

        {(status === 'available' || status === 'downloading') && update != null && (
          <>
            <p className="text-fg text-sm">
              {t('updater.available_body', { version: update.version })}
            </p>
            {update.notes != null && update.notes.trim() !== '' && (
              <div className="space-y-1">
                <p className="text-fg-secondary text-xs font-semibold">{t('updater.notes')}</p>
                {/* Release notes are remote text: rendered as plain text, never markdown or HTML. */}
                <p className="text-fg-secondary max-h-60 overflow-y-auto text-sm leading-relaxed whitespace-pre-wrap">
                  {update.notes}
                </p>
              </div>
            )}
          </>
        )}
      </Modal.Body>

      <Modal.Footer className="items-center">
        {status === 'downloading' ? (
          <p className="text-fg-secondary flex items-center gap-2 text-sm">
            <Loader2 className="size-4 shrink-0 motion-safe:animate-spin" strokeWidth={1.75} />
            <span>{t('updater.installing')}</span>
          </p>
        ) : status === 'available' ? (
          <>
            <Button variant="secondary" size="md" onClick={dismiss}>
              {t('updater.later')}
            </Button>
            <Button variant="primary" size="md" disabled={busy} onClick={() => void install()}>
              <ArrowDownToLine className="size-4" strokeWidth={1.75} />
              {t('updater.install')}
            </Button>
          </>
        ) : (
          <>
            {status === 'checking' && (
              <Loader2
                className="text-fg-muted mr-auto size-4 shrink-0 motion-safe:animate-spin"
                strokeWidth={1.75}
              />
            )}
            <Button variant="secondary" size="md" onClick={dismiss}>
              {t('updater.close')}
            </Button>
          </>
        )}
      </Modal.Footer>
    </Modal>
  )
}
