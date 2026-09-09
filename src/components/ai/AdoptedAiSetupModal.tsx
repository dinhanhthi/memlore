import { Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAdoptedAiSetupPrompt } from '../../hooks/useAdoptedAiSetupPrompt'
import type { AiModelSlotId } from '../../lib/aiProviderStatus'
import { Button } from '../common/Button'
import { Modal } from '../common/Modal'
import { AIStep } from '../onboarding/steps/AIStep'

const SLOT_LABEL_KEY: Record<AiModelSlotId, string> = {
  chat: 'setup_attention.slot_chat',
  image: 'setup_attention.slot_image',
  embed: 'setup_attention.slot_embed',
}

/**
 * New-device prompt: cloud already has AI slots, this machine has no
 * credentials. Ask first, then reuse onboarding `AIStep` in adopt mode.
 * Mount once in the unlocked App shell; self-gates on hook state.
 */
export function AdoptedAiSetupModal() {
  const { t } = useTranslation(['ai', 'auth'])
  const { open, phase, slots, startWizard, backToAsk, dismiss, complete } =
    useAdoptedAiSetupPrompt()

  if (!open) return null

  const slotList = slots.map((id) => t(SLOT_LABEL_KEY[id])).join(t('setup_attention.slot_list_sep'))

  if (phase === 'wizard') {
    return (
      <Modal onClose={() => undefined} disableEsc disableBackdrop maxWidth={560}>
        <Modal.Header>
          <span className="flex items-center gap-2">
            <Sparkles className="text-accent size-5 shrink-0" strokeWidth={1.75} />
            <span className="font-title text-xl font-semibold">
              {t('adopt_setup.wizard_title')}
            </span>
          </span>
        </Modal.Header>
        <AIStep
          mode="adopt"
          chrome="modal"
          adoptSlots={slots}
          onComplete={() => void complete()}
          onExitStep={backToAsk}
          onCancel={() => void dismiss()}
        />
      </Modal>
    )
  }

  return (
    <Modal onClose={() => undefined} disableEsc disableBackdrop maxWidth={560}>
      <Modal.Header description={t('adopt_setup.body', { slots: slotList })}>
        <span className="flex items-center gap-2">
          <Sparkles className="text-accent size-5 shrink-0" strokeWidth={1.75} />
          <span className="font-title text-xl font-semibold">{t('adopt_setup.title')}</span>
        </span>
      </Modal.Header>
      <Modal.Footer>
        <Button variant="ghost" size="sm" onClick={() => void dismiss()}>
          {t('adopt_setup.cancel')}
        </Button>
        <Button variant="primary" size="sm" onClick={startWizard}>
          {t('adopt_setup.yes')}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
