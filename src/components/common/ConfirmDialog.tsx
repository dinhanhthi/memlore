import { useState } from 'react'
import { Modal } from './Modal'
import { Button } from './Button'

interface ConfirmDialogProps {
  open: boolean
  title: string
  description: string
  /** Label for the confirm button. Defaults to "Delete". */
  confirmLabel?: string
  onConfirm: () => void | Promise<void>
  onClose: () => void
}

/**
 * A reusable confirmation dialog built on `<Modal>`.
 *
 * Renders nothing when `open` is false. Shows a title, a description, and
 * two action buttons: a ghost "Cancel" and a destructive confirm button.
 * The confirm button is disabled while an async `onConfirm` is in flight
 * to prevent double-submissions.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Delete',
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const [isPending, setIsPending] = useState(false)

  if (!open) return null

  const handleConfirm = () => {
    const result = onConfirm()
    if (result instanceof Promise) {
      setIsPending(true)
      result
        .then(() => onClose())
        .catch((err) => console.error('[ConfirmDialog] onConfirm error:', err))
        .finally(() => setIsPending(false))
    } else {
      onClose()
    }
  }

  return (
    <Modal onClose={onClose}>
      <Modal.Header description={description}>{title}</Modal.Header>
      <Modal.Footer>
        <Button variant="ghost" size="sm" onClick={onClose} disabled={isPending}>
          Cancel
        </Button>
        <Button variant="destructive" size="sm" onClick={handleConfirm} disabled={isPending}>
          {confirmLabel}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
