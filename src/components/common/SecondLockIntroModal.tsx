import { useTranslation } from 'react-i18next'
import { ShieldQuestion } from 'lucide-react'
import { Button } from './Button'
import { Modal } from './Modal'
import { useTabStore } from '../../stores/tabStore'

interface SecondLockIntroModalProps {
  open: boolean
  onClose: () => void
}

export function SecondLockIntroModal({ open, onClose }: SecondLockIntroModalProps) {
  const { t } = useTranslation('settings')
  if (!open) return null

  const goToSecurity = () => {
    useTabStore.getState().updateActiveTab({
      activeView: 'settings',
      selectedEntryId: null,
      settingsCategory: 'security',
    })
    onClose()
  }

  return (
    <Modal onClose={onClose} maxWidth={440}>
      <Modal.Header>
        <div className="flex items-start gap-4">
          <div
            aria-hidden="true"
            className="text-accent bg-accent-soft grid h-11 w-11 shrink-0 place-items-center rounded-[12px]"
          >
            <ShieldQuestion className="size-6" strokeWidth={1.75} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-title text-xl font-semibold">
              {t('security.second_lock.intro_title')}
            </div>
            <p className="text-fg-muted mt-1.5 text-sm leading-[1.55]">
              {t('security.second_lock.intro_body')}
            </p>
          </div>
        </div>
      </Modal.Header>
      <Modal.Footer>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('security.second_lock.cancel')}
        </Button>
        <Button size="sm" onClick={goToSecurity}>
          {t('security.second_lock.intro_open_settings')}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
