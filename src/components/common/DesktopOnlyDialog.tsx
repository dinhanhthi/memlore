import { MonitorSmartphone } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from './Button'
import { Modal } from './Modal'

interface DesktopOnlyDialogProps {
  open: boolean
  onClose: () => void
  title: string
  body: string
}

/** Info notice for an action the web build shows but only the desktop app can
 * do. Renders nothing when `open` is false. */
export function DesktopOnlyDialog({ open, onClose, title, body }: DesktopOnlyDialogProps) {
  const { t } = useTranslation('common')
  if (!open) return null

  return (
    <Modal onClose={onClose}>
      <Modal.Header description={body}>
        <span className="flex items-center gap-2">
          <MonitorSmartphone className="text-fg-muted size-5 shrink-0" aria-hidden />
          <span className="font-title text-xl font-semibold">{title}</span>
        </span>
      </Modal.Header>
      <Modal.Footer>
        <Button variant="primary" size="sm" onClick={onClose}>
          {t('web_unsupported.ok')}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
