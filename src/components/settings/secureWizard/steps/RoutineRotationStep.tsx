import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useAuth } from '../../../../hooks/useAuth'
import { useSecureWizardStore } from '../../../../stores/secureWizardStore'
import { useUiStore } from '../../../../stores/uiStore'
import { Callout } from '../../../common/Callout'
import { InlineOrb } from '../../../common/ThinkingOrb'
import {
  RotateCredentialFields,
  type RotateCredentialValues,
} from '../fields/RotateCredentialFields'
import type { SecureWizardStepProps } from '../types'
import { WizardDiagram } from '../WizardDiagram'

const EMPTY_CREDENTIALS: RotateCredentialValues = {
  phrase: '',
  password: '',
  isValid: false,
}

const ROTATION_ERROR_KEY = 'settings:security.rotate.error_fallback'

export function RoutineRotationStep({ render }: SecureWizardStepProps) {
  const { t } = useTranslation()
  const { rotateMasterKey } = useAuth()
  const step = useSecureWizardStore((store) => store.state.step)
  const stepStatus = useSecureWizardStore((store) => store.stepStatus)
  const errorKey = useSecureWizardStore((store) => store.errorKey)
  const choose = useSecureWizardStore((store) => store.choose)
  const close = useSecureWizardStore((store) => store.close)
  const setStepStatus = useSecureWizardStore((store) => store.setStepStatus)
  const rotationBusy = useUiStore((store) => store.rotationBusy)
  const setRotationBusy = useUiStore((store) => store.setRotationBusy)
  const [credentials, setCredentials] = useState<RotateCredentialValues>(EMPTY_CREDENTIALS)

  const handleRotate = async () => {
    if (!credentials.isValid || rotationBusy || stepStatus === 'running') {
      return
    }

    const password = credentials.password
    const phrase = credentials.phrase
    setCredentials(EMPTY_CREDENTIALS)

    choose('next')
    setStepStatus('running')
    setRotationBusy(true)

    try {
      const result = await rotateMasterKey(password, phrase)
      if (!result.success) {
        setStepStatus('error', ROTATION_ERROR_KEY)
        return
      }

      setCredentials(EMPTY_CREDENTIALS)
      setStepStatus('done')
      choose('next')
      setStepStatus('done')
    } catch {
      setStepStatus('error', ROTATION_ERROR_KEY)
    } finally {
      setRotationBusy(false)
    }
  }

  switch (step) {
    case 'routine_intro':
      return render({
        description: t('settings:security.secure_wizard.routine.intro_body'),
        content: (
          <div className="flex justify-center">
            <WizardDiagram
              variant="key-rotated"
              ariaLabel={t('settings:security.secure_wizard.diagrams.key_rotated')}
            />
          </div>
        ),
        primaryAction: {
          label: t('settings:security.rotate.rotate'),
          onClick: () => choose('next'),
          variant: 'destructive',
          disabled: rotationBusy,
        },
      })

    case 'routine_confirm':
      return render({
        description: t('settings:security.secure_wizard.routine.confirm_body'),
        content: (
          <div className="flex flex-col gap-4">
            <Callout tone="danger">{t('settings:security.rotate.warning')}</Callout>

            <RotateCredentialFields
              disabled={rotationBusy || stepStatus === 'running'}
              onChange={(values) => {
                setCredentials(values)
                if (stepStatus === 'error') {
                  setStepStatus('idle')
                }
              }}
            />
          </div>
        ),
        primaryAction: {
          label: t('settings:security.rotate.rotate'),
          onClick: () => {
            void handleRotate()
          },
          variant: 'destructive',
          disabled: !credentials.isValid || rotationBusy,
          loading: stepStatus === 'running',
        },
      })

    case 'routine_running':
      return render({
        content:
          stepStatus === 'error' && errorKey ? (
            <Callout tone="danger">{t(errorKey)}</Callout>
          ) : (
            <div className="flex flex-col items-center gap-4 py-4 text-center">
              <WizardDiagram
                variant="key-rotated"
                ariaLabel={t('settings:security.secure_wizard.diagrams.key_rotated')}
              />
              <div className="flex items-center justify-center gap-2" aria-live="polite">
                <InlineOrb state="searching" aria-hidden />
                <p className="text-fg-muted text-sm leading-relaxed">
                  {t('settings:security.rotate.busy')}
                </p>
              </div>
            </div>
          ),
        primaryAction: null,
      })

    case 'routine_done':
      return render({
        description: t('settings:security.rotate.success_repair_hint'),
        content: (
          <div className="flex justify-center">
            <WizardDiagram
              variant="key-rotated"
              ariaLabel={t('settings:security.secure_wizard.diagrams.key_rotated')}
            />
          </div>
        ),
        primaryAction: {
          label: t('settings:security.secure_wizard.done'),
          onClick: close,
          disabled: rotationBusy,
        },
      })

    default:
      return null
  }
}
