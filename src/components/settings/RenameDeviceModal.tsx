import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal } from '../common/Modal'
import { Button } from '../common/Button'
import { TextInput } from '../common/TextInput'
import { useUiStore } from '../../stores/uiStore'

interface Props {
  open: boolean
  deviceId: string
  currentName: string
  onRename: (deviceId: string, newName: string) => Promise<void>
  onClose: () => void
}

export function RenameDeviceModal({ open, deviceId, currentName, onRename, onClose }: Props) {
  const { t } = useTranslation('settings')
  const [name, setName] = useState(currentName)
  // Brief local guard against double-submit before the modal unmounts.
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const [prevReset, setPrevReset] = useState({ open, currentName })

  // Reset submitted/error/name when the modal opens or the device name changes.
  if (prevReset.open !== open || prevReset.currentName !== currentName) {
    setPrevReset({ open, currentName })
    if (open) {
      setName(currentName)
      setSubmitted(false)
      setError('')
    }
  }

  if (!open) return null

  const trimmed = name.trim()
  const canSave = trimmed.length > 0 && trimmed !== currentName && !submitted

  const handleSave = () => {
    if (!canSave) return
    // Guard before close: rename() silently no-ops when rotation/rename is
    // already busy — closing here would look like a successful rename.
    const ui = useUiStore.getState()
    if (ui.rotationBusy || ui.deviceRenameBusy) {
      setError(t('security.devices.rename_blocked'))
      return
    }
    setSubmitted(true)
    setError('')
    // Kick off background rename and close immediately — do not await Drive I/O.
    void onRename(deviceId, trimmed)
    onClose()
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && canSave) {
      handleSave()
    }
  }

  return (
    <Modal onClose={onClose} disableEsc={submitted} disableBackdrop={submitted}>
      <Modal.Header>{t('security.devices.rename_modal_title')}</Modal.Header>
      <Modal.Body fitContent>
        <label className="text-fg mb-1 block text-sm font-medium" htmlFor="device-rename-input">
          {t('security.devices.rename_label')}
        </label>
        <TextInput
          id="device-rename-input"
          ref={inputRef}
          value={name}
          onChange={setName}
          onKeyDown={handleKeyDown}
          autoFocus
          disabled={submitted}
          maxLength={80}
        />
        {error && (
          <p role="alert" className="text-danger-text mt-2 text-xs">
            {error}
          </p>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" size="sm" onClick={onClose} disabled={submitted}>
          {t('security.devices.rename_cancel')}
        </Button>
        <Button size="sm" disabled={!canSave} onClick={handleSave}>
          {t('security.devices.rename_save')}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
