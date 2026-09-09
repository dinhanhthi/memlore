import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ResetCounts } from '../../../../lib/tauri'
import { syncResetLocalState } from '../../../../lib/tauri'
import { useSyncRecoveryWizardStore } from '../../../../stores/syncRecoveryWizardStore'
import { useSyncStore } from '../../../../stores/syncStore'
import { Callout } from '../../../common/Callout'
import { InlineOrb } from '../../../common/ThinkingOrb'
import type { SecureWizardStepProps } from '../../secureWizard/types'

interface ResetOutcome {
  queued: boolean
  result: ResetCounts | null
}

export function ResetSteps({ render }: SecureWizardStepProps) {
  const { t } = useTranslation('settings')
  const step = useSyncRecoveryWizardStore((store) => store.state.step)
  const stepStatus = useSyncRecoveryWizardStore((store) => store.stepStatus)
  const error = useSyncRecoveryWizardStore((store) => store.error)
  const back = useSyncRecoveryWizardStore((store) => store.back)
  const close = useSyncRecoveryWizardStore((store) => store.close)
  const [outcome, setOutcome] = useState<ResetOutcome | null>(null)
  const [actionLocked, setActionLocked] = useState(false)
  const inFlightRef = useRef(false)

  const handleReset = async () => {
    if (inFlightRef.current) return
    const store = useSyncRecoveryWizardStore.getState()
    if (store.state.step !== 'reset_confirm' || store.stepStatus === 'running') return

    inFlightRef.current = true
    setActionLocked(true)
    store.choose('next')
    store.setStepStatus('running')

    try {
      const result = await syncResetLocalState()
      setOutcome({ queued: result.queued, result: result.result })
      store.setStepStatus('done')
      store.choose('next')
      await useSyncStore.getState().refresh()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      store.setStepStatus('error', t('gdrive.help.reset.error', { message }))
      inFlightRef.current = false
      setActionLocked(false)
    }
  }

  switch (step) {
    case 'reset_confirm':
      return render({
        description: t('gdrive.help.reset.modal_body'),
        content: (
          <p className="text-fg text-sm leading-snug font-semibold">
            {t('gdrive.help.reset.modal_title')}
          </p>
        ),
        primaryAction: {
          label: t('gdrive.help.reset.modal_confirm'),
          onClick: () => {
            void handleReset()
          },
          variant: 'secondary',
          disabled: actionLocked,
        },
      })

    case 'reset_running':
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
                {t('gdrive.recovery_wizard.reset.running')}
              </p>
            </div>
          </div>
        ),
        primaryAction: null,
      })

    case 'reset_done': {
      const counts = outcome?.result ?? { entries: 0, media: 0, journals: 0 }
      return render({
        description: t('gdrive.recovery_wizard.reset.done_title'),
        content: (
          <p className="text-fg text-sm leading-relaxed">
            {outcome?.queued
              ? t('gdrive.help.reset.queued')
              : t('gdrive.help.reset.success', {
                  entries: counts.entries,
                  media: counts.media,
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
