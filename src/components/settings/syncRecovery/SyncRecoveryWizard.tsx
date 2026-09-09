import { useTranslation } from 'react-i18next'
import type { RecoveryDirection } from '../../../lib/recoveryBlockerMessage'
import { prevStep, type SyncRecoveryWizardStep } from '../../../lib/syncRecoveryWizardGraph'
import { useSyncRecoveryWizardStore } from '../../../stores/syncRecoveryWizardStore'
import { Button } from '../../common/Button'
import { Modal } from '../../common/Modal'
import type { SecureWizardStepProps, SecureWizardStepView } from '../secureWizard/types'
import { ReplaceSteps } from './steps/ReplaceSteps'
import { ResetSteps } from './steps/ResetSteps'
import { StopSteps } from './steps/StopSteps'
import { TriageStep } from './steps/TriageStep'

export interface SyncRecoveryWizardProps {
  /** Re-fetch GDrive status in the parent after disconnect / delete-and-disconnect. */
  onStatusChanged: () => Promise<void>
  /** Parent runs the confirmed replace to completion (banner + success line live in the parent). */
  onRecoveryConfirmed: (direction: RecoveryDirection) => Promise<void>
  /** Parent-side "another action is busy" flag (isBusy || recoveryBlocksActions). */
  actionsDisabled: boolean
}

interface WizardStepProps extends SecureWizardStepProps {
  step: SyncRecoveryWizardStep
  onStatusChanged: () => Promise<void>
  onRecoveryConfirmed: (direction: RecoveryDirection) => Promise<void>
}

function WizardStep({ step, render, onStatusChanged, onRecoveryConfirmed }: WizardStepProps) {
  switch (step) {
    case 'triage':
      return <TriageStep render={render} />

    case 'reset_confirm':
    case 'reset_running':
    case 'reset_done':
      return <ResetSteps render={render} />

    case 'cloud_to_local_confirm':
    case 'local_to_cloud_confirm':
      return <ReplaceSteps render={render} onRecoveryConfirmed={onRecoveryConfirmed} />

    case 'stop_choice':
    case 'disconnect_confirm':
    case 'disconnect_running':
    case 'disconnect_done':
    case 'delete_confirm':
    case 'delete_running':
    case 'delete_done':
      return <StopSteps render={render} onStatusChanged={onStatusChanged} />

    default: {
      const unreachableStep: never = step
      throw new Error(`Unhandled sync recovery wizard step: ${String(unreachableStep)}`)
    }
  }
}

export function SyncRecoveryWizard({
  onStatusChanged,
  onRecoveryConfirmed,
}: SyncRecoveryWizardProps) {
  const { t } = useTranslation('settings')
  const open = useSyncRecoveryWizardStore((store) => store.open)
  const state = useSyncRecoveryWizardStore((store) => store.state)
  const stepStatus = useSyncRecoveryWizardStore((store) => store.stepStatus)
  const close = useSyncRecoveryWizardStore((store) => store.close)
  const back = useSyncRecoveryWizardStore((store) => store.back)

  const running = stepStatus === 'running'
  const isDoneStep = state.step.endsWith('_done')
  const canGoBack = state.step !== 'triage' && !isDoneStep && prevStep(state).step !== state.step

  const handleClose = () => {
    if (running) return
    close()
  }

  if (!open) return null

  const renderStep = ({ description, content, primaryAction }: SecureWizardStepView) => {
    const primaryDisabled =
      primaryAction != null &&
      (running || primaryAction.loading === true || primaryAction.disabled === true)
    const primaryButton = primaryAction && (
      <Button
        variant={primaryAction.variant ?? 'primary'}
        size="sm"
        onClick={primaryAction.onClick}
        loading={primaryAction.loading}
        disabled={primaryDisabled}
        data-testid="gdrive-recovery-primary"
      >
        {primaryAction.label}
      </Button>
    )

    return (
      <>
        <Modal.Header description={description}>
          <span className="font-title text-fg text-xl font-semibold">
            {t('gdrive.recovery_wizard.modal_title')}
          </span>
        </Modal.Header>
        {content != null && content !== false && content !== '' && (
          <Modal.Body>
            <fieldset
              disabled={running}
              className="m-0 min-w-0 border-0 p-0 disabled:cursor-not-allowed"
            >
              {content}
            </fieldset>
          </Modal.Body>
        )}
        {(canGoBack || primaryAction !== null) && (
          <Modal.Footer>
            {canGoBack && (
              <Button
                variant="secondary"
                size="sm"
                onClick={back}
                disabled={running}
                data-testid="gdrive-recovery-back"
              >
                {t('gdrive.recovery_wizard.back')}
              </Button>
            )}
            {primaryButton}
          </Modal.Footer>
        )}
      </>
    )
  }

  return (
    <Modal
      onClose={handleClose}
      disableEsc={running}
      disableBackdrop={running}
      className="bg-elevated"
    >
      <div className="contents" data-testid="gdrive-recovery-wizard">
        <WizardStep
          step={state.step}
          render={renderStep}
          onStatusChanged={onStatusChanged}
          onRecoveryConfirmed={onRecoveryConfirmed}
        />
      </div>
    </Modal>
  )
}
