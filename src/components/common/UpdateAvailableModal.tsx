import { AlertTriangle, ArrowDownToLine, CheckCircle2, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from './Button'
import { Modal } from './Modal'
import { renderSimpleMarkdown } from '../../lib/simpleMarkdown'
import { useUpdater, type UpdaterStatus } from '../../hooks/useUpdater'

/** The states that belong in a modal — the ones the user is waiting on an
 *  answer for. Everything after "Update now" happens in the background
 *  (`downloading`), on a card (`ready-to-restart`) or in a toast
 *  (`install-failed`), so none of those open this. */
type ModalStatus = 'checking' | 'available' | 'up-to-date' | 'error'

function isModalStatus(status: UpdaterStatus): status is ModalStatus {
  return (
    status === 'checking' || status === 'available' || status === 'up-to-date' || status === 'error'
  )
}

const TITLE_KEY: Record<ModalStatus, string> = {
  checking: 'updater.checking',
  available: 'updater.available',
  'up-to-date': 'updater.up_to_date',
  error: 'updater.failed',
}

/**
 * The question-asking half of the updater UI (`useUpdater`): "there's a new
 * version, want it?", plus the menu item's checking / up-to-date / failed
 * answers. The silent startup check only leaves `idle` when it actually found
 * something, so this stays invisible at boot.
 *
 * It never blocks: pressing "Update now" closes it immediately and the install
 * continues in the background.
 */
export function UpdateAvailableModal() {
  const { t } = useTranslation('common')
  const { status, update, error, install, dismiss } = useUpdater()

  if (!isModalStatus(status)) return null

  return (
    <Modal onClose={dismiss}>
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

        {status === 'error' && (
          <div className="space-y-2">
            <p className="text-fg-secondary flex items-start gap-2 text-sm">
              <AlertTriangle className="text-fg-muted mt-0.5 size-4 shrink-0" strokeWidth={1.75} />
              <span>{t('updater.failed_body')}</span>
            </p>
            {error != null && (
              <p className="text-fg-muted font-mono text-xs break-words">{error}</p>
            )}
          </div>
        )}

        {status === 'available' && update != null && (
          <>
            <p className="text-fg text-sm">
              {t('updater.available_body', { version: update.version })}
            </p>
            {update.notes != null && update.notes.trim() !== '' && (
              <div className="space-y-1">
                <p className="text-fg-secondary text-xs font-semibold">{t('updater.notes')}</p>
                {/* Release notes are remote text. `renderSimpleMarkdown` only
                    ever builds React element trees with text leaves — no raw
                    HTML escape hatch — so the GitHub release body cannot inject
                    markup however it is written. */}
                <div className="text-fg-secondary max-h-60 space-y-2 overflow-y-auto text-sm leading-relaxed">
                  {renderSimpleMarkdown(update.notes)}
                </div>
              </div>
            )}
          </>
        )}
      </Modal.Body>

      <Modal.Footer className="items-center">
        {status === 'available' ? (
          <>
            <Button variant="secondary" size="md" onClick={dismiss}>
              {t('updater.later')}
            </Button>
            <Button
              variant="primary"
              size="md"
              // Closing is implicit: `install()` moves the state machine to
              // `downloading`, which this modal does not render. The download
              // must not be something the user has to sit and watch.
              onClick={() => void install()}
            >
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
