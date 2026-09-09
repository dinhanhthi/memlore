import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Trash2 } from 'lucide-react'
import { Button } from './Button'
import { Modal } from './Modal'

interface DeleteConfirmModalProps {
  title: string
  /// Body is rendered as-is so callers can mix bold names, counts, etc.
  body: React.ReactNode
  error?: string | null
  /// Custom labels (default to settings.delete_modal.{cancel,delete}).
  cancelLabel?: string
  confirmLabel?: string
  onCancel: () => void
  /// May be async — the modal shows a spinner on the Delete button and
  /// disables both actions until the returned promise settles.
  onConfirm: () => void | Promise<void>
}

/// Shared red-icon destructive-confirm Modal. Used by JournalsSettings,
/// TemplatesSettings, and the Sidebar journal delete flow — all three
/// previously inlined the same shell with subtly drifting copy and
/// inconsistent i18n coverage.
export function DeleteConfirmModal({
  title,
  body,
  error,
  cancelLabel,
  confirmLabel,
  onCancel,
  onConfirm,
}: DeleteConfirmModalProps) {
  const { t } = useTranslation('settings')
  const [isBusy, setIsBusy] = useState(false)

  const handleConfirm = async () => {
    if (isBusy) return
    setIsBusy(true)
    try {
      await onConfirm()
    } finally {
      setIsBusy(false)
    }
  }

  return (
    <Modal onClose={onCancel} maxWidth={420}>
      <Modal.Header>
        <div className="flex items-start gap-4">
          <div
            aria-hidden="true"
            className="text-danger bg-danger/12 dark:bg-danger/18 grid h-11 w-11 shrink-0 place-items-center rounded-xl"
          >
            <Trash2 className="size-6" strokeWidth={1.75} />
          </div>
          <div className="flex-1">
            <div className="font-title text-xl font-semibold">{title}</div>
            <div className="text-fg-muted mt-1.5 text-sm leading-[1.55]">{body}</div>
            {error && <p className="text-danger-text mt-2.5 text-sm leading-[1.55]">{error}</p>}
          </div>
        </div>
      </Modal.Header>
      <Modal.Footer>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={isBusy}>
          {cancelLabel ?? t('delete_modal.cancel', { defaultValue: 'Cancel' })}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          loading={isBusy}
          onClick={() => void handleConfirm()}
        >
          {confirmLabel ?? t('delete_modal.delete', { defaultValue: 'Delete' })}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
