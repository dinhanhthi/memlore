import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../common/Button'
import { Modal } from '../common/Modal'
import type { CelebrationVariant } from '../../stores/onboardingStore'

interface OnboardingCelebrationModalProps {
  open: boolean
  onClose: () => void
  /** Which copy to show.
   *  - `setup` — fresh vault, no Drive.
   *  - `setup-sync` — fresh vault with Drive; first sync running in footer.
   *  - `joined-sync` — joined an existing cloud vault; first download running. */
  variant?: CelebrationVariant
}

const VARIANT_COPY_KEY: Record<CelebrationVariant, 'celebration' | 'setup_sync' | 'joined_sync'> = {
  setup: 'celebration',
  'setup-sync': 'setup_sync',
  'joined-sync': 'joined_sync',
}

/**
 * One-shot welcome modal after the post-setup onboarding wizard finishes,
 * or after this device joins an existing cloud vault. Shown over the main
 * app shell the first time the user lands there; dismissed via CTA / Esc /
 * backdrop and never re-armed. Sync-aware variants (`setup-sync`,
 * `joined-sync`) tell the user the first sync keeps running in the footer.
 */
export function OnboardingCelebrationModal({
  open,
  onClose,
  variant = 'setup',
}: OnboardingCelebrationModalProps) {
  const { t } = useTranslation('auth')
  const titleId = useId()

  if (!open) return null

  const copyKey = VARIANT_COPY_KEY[variant] ?? 'celebration'

  return (
    <Modal onClose={onClose} maxWidth={400} labelledBy={titleId}>
      <Modal.Body
        fitContent
        className="flex flex-col items-center gap-3 px-8 pt-10 pb-4 text-center"
      >
        <img
          src="/stickers/sticker-celebrate.png"
          alt=""
          aria-hidden="true"
          draggable={false}
          className="mb-1 block h-28 w-auto shrink-0"
        />
        <h2 id={titleId} className="font-title text-fg text-xl font-semibold">
          {t(`onboarding.${copyKey}.title`)}
        </h2>
        <p className="text-fg-muted max-w-xs text-sm leading-relaxed">
          {t(`onboarding.${copyKey}.body`)}
        </p>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="primary" size="md" onClick={onClose}>
          {t(`onboarding.${copyKey}.cta`)}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
