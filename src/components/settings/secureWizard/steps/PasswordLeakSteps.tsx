import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useAuth } from '../../../../hooks/useAuth'
import { useSecureWizardStore } from '../../../../stores/secureWizardStore'
import { Button } from '../../../common/Button'
import { ChangePasswordFields, type ChangePasswordValues } from '../fields/ChangePasswordFields'
import type { SecureWizardStepProps } from '../types'

const EMPTY_PASSWORD_VALUES: ChangePasswordValues = {
  oldPassword: '',
  newPassword: '',
  confirmPassword: '',
  isValid: false,
}

export function PasswordLeakSteps({ render }: SecureWizardStepProps) {
  const { t } = useTranslation()
  const { changePassword } = useAuth()
  const step = useSecureWizardStore((store) => store.state.step)
  const stepStatus = useSecureWizardStore((store) => store.stepStatus)
  const errorKey = useSecureWizardStore((store) => store.errorKey)
  const choose = useSecureWizardStore((store) => store.choose)
  const close = useSecureWizardStore((store) => store.close)
  const setStepStatus = useSecureWizardStore((store) => store.setStepStatus)
  const [passwordValues, setPasswordValues] = useState<ChangePasswordValues>(EMPTY_PASSWORD_VALUES)
  const [passwordFieldsKey, setPasswordFieldsKey] = useState(0)
  const [passwordChanged, setPasswordChanged] = useState(false)

  useEffect(() => {
    // Credentials are only valid at password_change; clear on any other step
    // so they never survive navigation away from that screen (plan decision #8).
    if (step !== 'password_change') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- security guard: clear sensitive credentials when leaving the entry step
      setPasswordValues(EMPTY_PASSWORD_VALUES)
    }
  }, [step])

  if (step === 'password_leaked') {
    return render({
      description: t('settings:security.secure_wizard.password.body'),
      content: (
        <div className="space-y-3">
          <p className="text-fg text-sm font-medium">
            {t('settings:security.secure_wizard.password.device_question')}
          </p>
          <div className="flex flex-row items-center gap-2">
            <Button variant="secondary" onClick={() => choose('device_reached')}>
              {t('settings:security.secure_wizard.password.device_yes')}
            </Button>
            <Button variant="secondary" onClick={() => choose('device_not_reached')}>
              {t('settings:security.secure_wizard.password.device_no')}
            </Button>
          </div>
        </div>
      ),
      primaryAction: null,
    })
  }

  if (step !== 'password_change') {
    return null
  }

  const handlePasswordValuesChange = (values: ChangePasswordValues) => {
    setPasswordValues(values)
    if (stepStatus === 'error') {
      setStepStatus('idle')
    }
  }

  const handlePasswordChange = async () => {
    if (!passwordValues.isValid || stepStatus === 'running') {
      return
    }

    setStepStatus('running')
    const result = await changePassword(passwordValues.oldPassword, passwordValues.newPassword)

    if (!result.success) {
      setStepStatus('error', 'settings:security.secure_wizard.errors.generic')
      return
    }

    setPasswordValues(EMPTY_PASSWORD_VALUES)
    setPasswordFieldsKey((key) => key + 1)
    setPasswordChanged(true)
    setStepStatus('done')
  }

  if (passwordChanged) {
    return render({
      description: t('settings:security.secure_wizard.password.change_success_body'),
      content: (
        <Button variant="secondary" onClick={() => choose('rotate_key')}>
          {t('settings:security.secure_wizard.password.rotate_too')}
        </Button>
      ),
      primaryAction: {
        label: t('settings:security.secure_wizard.done'),
        onClick: close,
      },
    })
  }

  return render({
    description: t('settings:security.secure_wizard.password.change_body'),
    content: (
      <div className="space-y-5">
        <ChangePasswordFields
          key={passwordFieldsKey}
          disabled={stepStatus === 'running'}
          onChange={handlePasswordValuesChange}
        />

        {stepStatus === 'error' && errorKey ? (
          <p role="alert" className="text-danger-text text-sm">
            {t(errorKey)}
          </p>
        ) : null}
      </div>
    ),
    primaryAction: {
      label: t(
        stepStatus === 'running'
          ? 'settings:security.password.updating'
          : 'settings:security.password.update',
      ),
      onClick: () => {
        void handlePasswordChange()
      },
      disabled: !passwordValues.isValid,
      loading: stepStatus === 'running',
    },
  })
}
