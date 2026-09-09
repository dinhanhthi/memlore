import { useTranslation } from 'react-i18next'
import { prevStep, stepCounter, type SecureWizardStep } from '../../../lib/secureWizardGraph'
import { useSecureWizardStore } from '../../../stores/secureWizardStore'
import { useUiStore } from '../../../stores/uiStore'
import { Button } from '../../common/Button'
import { Modal } from '../../common/Modal'
import { Tooltip } from '../../common/Tooltip'
import { CutoffSteps } from './steps/CutoffSteps'
import { DeviceBranchSteps } from './steps/DeviceBranchSteps'
import { PasswordLeakSteps } from './steps/PasswordLeakSteps'
import { PhraseLeakSteps } from './steps/PhraseLeakSteps'
import { RoutineRotationStep } from './steps/RoutineRotationStep'
import { TriageStep } from './steps/TriageStep'
import type { SecureWizardStepProps, SecureWizardStepView } from './types'

interface WizardStepProps extends SecureWizardStepProps {
  step: SecureWizardStep
}

function WizardStep({ step, render }: WizardStepProps) {
  switch (step) {
    case 'triage':
      return <TriageStep render={render} />

    case 'words_leaked':
    case 'reset_confirm':
    case 'reset_running':
    case 'reset_done':
      return <PhraseLeakSteps render={render} />

    case 'password_leaked':
    case 'password_change':
      return <PasswordLeakSteps render={render} />

    case 'device_pick':
    case 'device_words':
    case 'device_scope':
    case 'revoke_confirm':
    case 'revoke_running':
    case 'revoke_done':
    case 'remove_confirm':
    case 'remove_running':
    case 'remove_done':
      return <DeviceBranchSteps render={render} />

    case 'cutoff_1':
    case 'cutoff_2':
    case 'cutoff_3':
    case 'cutoff_done':
      return <CutoffSteps render={render} />

    case 'routine_intro':
    case 'routine_confirm':
    case 'routine_running':
    case 'routine_done':
      return <RoutineRotationStep render={render} />

    default: {
      const unreachableStep: never = step
      throw new Error(`Unhandled secure wizard step: ${String(unreachableStep)}`)
    }
  }
}

export function SecureJournalWizard() {
  const { t } = useTranslation('settings')
  const open = useSecureWizardStore((store) => store.open)
  const state = useSecureWizardStore((store) => store.state)
  const stepStatus = useSecureWizardStore((store) => store.stepStatus)
  const close = useSecureWizardStore((store) => store.close)
  const back = useSecureWizardStore((store) => store.back)
  const rotationBusy = useUiStore((store) => store.rotationBusy)
  const pendingRotationPhrase = useUiStore((store) => store.pendingRotationPhrase)

  const running = stepStatus === 'running'
  const interactionLocked = rotationBusy || running
  const counter = stepCounter(state)
  const canGoBack = state.step !== 'triage' && prevStep(state).step !== state.step
  const handleClose = () => {
    if (interactionLocked) return
    close()
  }

  if (!open) return null

  // Both this wizard and the reveal modal are z-1000 portals. Hide without
  // closing so the only surviving mnemonic is never obscured, while the
  // wizard session stays intact and resumes at the same step after reveal.
  if (pendingRotationPhrase !== null) return null

  const renderStep = ({ description, content, primaryAction }: SecureWizardStepView) => {
    const primaryDisabled =
      primaryAction != null &&
      (interactionLocked || primaryAction.loading === true || primaryAction.disabled === true)
    const primaryButton = primaryAction && (
      <Button
        variant={primaryAction.variant ?? 'primary'}
        size="sm"
        onClick={primaryAction.onClick}
        loading={primaryAction.loading}
        disabled={primaryDisabled}
        // Disabled buttons swallow hover events; the tooltip listens on the
        // wrapper span, so let the pointer fall through to it.
        className={primaryAction.tooltip && primaryDisabled ? 'pointer-events-none' : undefined}
      >
        {primaryAction.label}
      </Button>
    )

    return (
      <>
        <Modal.Header description={description}>
          <div className="flex items-center justify-between gap-4">
            <span className="font-title text-fg text-xl font-semibold">
              {t('security.secure_wizard.modal_title')}
            </span>
            {counter && (
              <span className="text-fg-muted shrink-0 text-xs font-medium">
                {t('security.secure_wizard.step_counter', counter)}
              </span>
            )}
          </div>
        </Modal.Header>
        {content != null && content !== false && content !== '' && (
          <Modal.Body>
            <fieldset
              disabled={interactionLocked}
              className="m-0 min-w-0 border-0 p-0 disabled:cursor-not-allowed"
            >
              {content}
            </fieldset>
          </Modal.Body>
        )}
        {(canGoBack || primaryAction !== null) && (
          <Modal.Footer>
            {canGoBack && (
              <Button variant="secondary" size="sm" onClick={back} disabled={interactionLocked}>
                {t('security.secure_wizard.back')}
              </Button>
            )}
            {primaryAction?.tooltip ? (
              <Tooltip content={primaryAction.tooltip} multiline placement="top">
                {primaryButton}
              </Tooltip>
            ) : (
              primaryButton
            )}
          </Modal.Footer>
        )}
      </>
    )
  }

  return (
    <Modal
      onClose={handleClose}
      disableEsc={interactionLocked}
      disableBackdrop={interactionLocked}
      className="bg-elevated"
    >
      <WizardStep step={state.step} render={renderStep} />
    </Modal>
  )
}
