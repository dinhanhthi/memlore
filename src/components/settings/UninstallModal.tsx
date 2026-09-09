import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'

import { Button } from '../common/Button'
import { Modal } from '../common/Modal'
import { TextInput } from '../common/TextInput'
import { formatBytes } from '../../lib/numbers'
import { useUninstall } from '../../hooks/useUninstall'
import { useTabStore } from '../../stores/tabStore'
import { Toggle } from './Toggle'

/**
 * Literal string the user must type to arm the confirm button.
 *
 * Deliberately NOT localized: a mistranslated confirmation token would either
 * lock a user out of the feature or — worse — shorten the gate to something
 * easy to type by reflex. It matches `productName` in `tauri.conf.json`.
 *
 * This is a considered-consent gate, not an authorization gate. The backend
 * shows its own native OS confirmation, which is what actually stops a
 * script-initiated `invoke('uninstall_app')`.
 */
const CONFIRM_TOKEN = 'Memlore'

/** Which "we can't remove the binary" explanation applies on this platform. */
function notRemovableKey(platform: string): string {
  switch (platform) {
    case 'macos':
      return 'general.uninstall.app_not_removable_macos'
    case 'windows':
      return 'general.uninstall.app_not_removable_windows'
    case 'linux':
      return 'general.uninstall.app_not_removable_linux'
    default:
      // `platform_id()` really can return "other", and the backend refuses to
      // spawn a reaper there — telling that user to "move it to the Trash"
      // would be actively wrong advice.
      return 'general.uninstall.app_not_removable_other'
  }
}

interface UninstallModalProps {
  onClose: () => void
}

export function UninstallModal({ onClose }: UninstallModalProps) {
  const { t } = useTranslation('settings')
  const { preview, loading, running, stalled, error, load, run } = useUninstall()
  const [typed, setTyped] = useState('')
  const [removeApp, setRemoveApp] = useState(true)
  const confirmId = useId()

  useEffect(() => {
    void load()
  }, [load])

  const appRemovable = preview?.appRemovable ?? false
  const armed = typed === CONFIRM_TOKEN && preview != null && !running
  // While the wipe is in flight there is nothing to cancel and the app is
  // about to vanish — but if exit stalls, give the escape hatches back rather
  // than seal the user into an unclosable dialog.
  const locked = running && !stalled

  const goToExport = () => {
    useTabStore.getState().updateActiveTab({ settingsCategory: 'data', dataTab: 'export' })
    onClose()
  }

  return (
    <Modal onClose={onClose} maxWidth={560} disableBackdrop={locked} disableEsc={locked}>
      <Modal.Header description={t('general.uninstall.modal_body')}>
        <span className="flex items-center gap-2">
          <AlertTriangle className="text-danger size-5 shrink-0" strokeWidth={1.75} aria-hidden />
          <span className="font-title text-xl font-semibold">
            {t('general.uninstall.modal_title')}
          </span>
        </span>
      </Modal.Header>

      <Modal.Body className="space-y-4">
        {error != null && (
          <p className="text-danger-text text-sm" role="alert">
            {error}
          </p>
        )}

        {stalled && (
          <p className="text-danger-text text-sm" role="alert">
            {t('general.uninstall.stalled')}
          </p>
        )}

        {loading && <p className="text-fg-muted text-sm">{t('general.uninstall.loading')}</p>}

        {preview != null && (
          <>
            <div>
              <p className="text-fg-secondary mb-1.5 text-xs font-medium">
                {t('general.uninstall.removes_label', { size: formatBytes(preview.totalBytes) })}
              </p>
              <ul className="bg-panel-2 border-border-subtle max-h-40 overflow-y-auto rounded-lg border px-3 py-2">
                {preview.paths.map((p) => (
                  <li key={p} className="text-fg-muted font-mono text-xs wrap-break-word">
                    {p}
                  </li>
                ))}
              </ul>
            </div>

            {/* The wipe is knowingly incomplete — say so instead of letting the
                header's "no copy is kept" promise stand unqualified. */}
            {preview.skipped.length > 0 && (
              <div>
                <p className="text-danger-text mb-1.5 text-xs font-medium">
                  {t('general.uninstall.skipped_label')}
                </p>
                <ul className="border-danger-border max-h-24 overflow-y-auto rounded-lg border px-3 py-2">
                  {preview.skipped.map((p) => (
                    <li key={p} className="text-fg-muted font-mono text-xs wrap-break-word">
                      {p}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {preview.appPath != null && appRemovable ? (
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-fg text-sm">{t('general.uninstall.also_remove_app')}</p>
                  <p className="text-fg-muted mt-0.5 font-mono text-xs wrap-break-word">
                    {t('general.uninstall.app_path_hint', { path: preview.appPath })}
                  </p>
                </div>
                <Toggle
                  ariaLabel={t('general.uninstall.also_remove_app')}
                  checked={removeApp}
                  onChange={setRemoveApp}
                  disabled={locked}
                />
              </div>
            ) : (
              <p className="text-fg-muted text-sm">{t(notRemovableKey(preview.platform))}</p>
            )}

            <p className="text-fg-muted text-xs">{t('general.uninstall.cloud_note')}</p>

            <button
              type="button"
              onClick={goToExport}
              disabled={locked}
              className="text-accent cursor-pointer text-sm underline underline-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('general.uninstall.export_first')}
            </button>

            <div>
              {/* The label IS the instruction, so it is the accessible name.
                  No `aria-describedby` back to it — that would make a screen
                  reader announce the same sentence twice. */}
              <label htmlFor={confirmId} className="text-fg-secondary text-sm">
                {t('general.uninstall.confirm_hint', { token: CONFIRM_TOKEN })}
              </label>
              <TextInput
                id={confirmId}
                className="mt-1.5"
                value={typed}
                onChange={setTyped}
                disabled={locked}
                autoComplete="off"
                spellCheck={false}
                placeholder={CONFIRM_TOKEN}
              />
            </div>
          </>
        )}
      </Modal.Body>

      <Modal.Footer>
        {/* `outline`, not `ghost`: both footer buttons are already h-8, but a
            borderless ghost reads as a bare text link next to the destructive
            button's bordered capsule. The visible edge makes the two boxes
            match. */}
        <Button variant="outline" size="sm" onClick={onClose} disabled={locked}>
          {t('general.uninstall.cancel')}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={!armed}
          loading={locked}
          onClick={() => void run(appRemovable && removeApp)}
        >
          {running ? t('general.uninstall.running') : t('general.uninstall.confirm_button')}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
