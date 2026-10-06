import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSyncRepair } from '../../../../hooks/useSyncRepair'
import { useSyncRecoveryWizardStore } from '../../../../stores/syncRecoveryWizardStore'
import { Callout } from '../../../common/Callout'
import { InlineOrb } from '../../../common/ThinkingOrb'
import type { SecureWizardStepProps } from '../../secureWizard/types'

interface RepairOutcome {
  queued: boolean
  result: { entries: number; journals: number } | null
}

export function RepairSteps({ render }: SecureWizardStepProps) {
  const { t } = useTranslation('settings')
  const { repair } = useSyncRepair()
  const step = useSyncRecoveryWizardStore((store) => store.state.step)
  const stepStatus = useSyncRecoveryWizardStore((store) => store.stepStatus)
  const error = useSyncRecoveryWizardStore((store) => store.error)
  const back = useSyncRecoveryWizardStore((store) => store.back)
  const close = useSyncRecoveryWizardStore((store) => store.close)
  const [outcome, setOutcome] = useState<RepairOutcome | null>(null)
  const [actionLocked, setActionLocked] = useState(false)
  const inFlightRef = useRef(false)

  const handleRepair = async () => {
    if (inFlightRef.current) return
    const store = useSyncRecoveryWizardStore.getState()
    if (store.state.step !== 'repair_confirm' || store.stepStatus === 'running') return

    inFlightRef.current = true
    setActionLocked(true)
    store.choose('next')
    store.setStepStatus('running')

    try {
      const result = await repair()
      setOutcome({ queued: result.queued, result: result.result })
      store.setStepStatus('done')
      store.choose('next')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      store.setStepStatus('error', t('gdrive.recovery_wizard.repair.error', { message }))
      inFlightRef.current = false
      setActionLocked(false)
    }
  }

  switch (step) {
    case 'repair_confirm':
      return render({
        description: t('gdrive.recovery_wizard.repair.confirm_body'),
        content: (
          <p className="text-fg text-sm leading-snug font-semibold">
            {t('gdrive.recovery_wizard.repair.confirm_title')}
          </p>
        ),
        primaryAction: {
          label: t('gdrive.recovery_wizard.repair.confirm_button'),
          onClick: () => {
            void handleRepair()
          },
          variant: 'secondary',
          disabled: actionLocked,
        },
      })

    case 'repair_running':
      if (stepStatus === 'error' && error) {
        return render({
          content: <Callout tone="danger">{error}</Callout>,
          primaryAction: {
            label: t('gdrive.recovery_wizard.back'),
            onClick: back,
            variant: 'secondary',
          },
        })
      }

      return render({
        content: (
          <div className="flex flex-col items-center gap-3 py-5 text-center">
            <div className="flex items-center justify-center gap-2" aria-live="polite">
              <InlineOrb state="searching" aria-hidden />
              <p className="text-fg-muted text-sm leading-relaxed">
                {t('gdrive.recovery_wizard.repair.running')}
              </p>
            </div>
          </div>
        ),
        primaryAction: null,
      })

    case 'repair_done': {
      const counts = outcome?.result ?? { entries: 0, journals: 0 }
      return render({
        description: t('gdrive.recovery_wizard.repair.done_title'),
        content: (
          <p className="text-fg text-sm leading-relaxed">
            {outcome?.queued
              ? t('gdrive.recovery_wizard.repair.queued')
              : t('gdrive.recovery_wizard.repair.success', {
                  entries: counts.entries,
                  journals: counts.journals,
                })}
          </p>
        ),
        primaryAction: {
          label: t('gdrive.recovery_wizard.done'),
          onClick: close,
        },
      })
    }

    default:
      return null
  }
}
