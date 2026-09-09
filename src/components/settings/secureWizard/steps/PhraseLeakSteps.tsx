import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../../../hooks/useAuth'
import { useSecureWizardStore } from '../../../../stores/secureWizardStore'
import { useUiStore } from '../../../../stores/uiStore'
import { Callout } from '../../../common/Callout'
import { PasswordInput } from '../../../common/PasswordInput'
import { InlineOrb } from '../../../common/ThinkingOrb'
import { WizardDiagram } from '../WizardDiagram'
import type { SecureWizardStepProps } from '../types'

const RESET_FALLBACK_ERROR = 'settings:security.reset.error_fallback'
const RESET_NO_PHRASE_ERROR = 'settings:security.reset.error_no_phrase'

export function PhraseLeakSteps({ render }: SecureWizardStepProps) {
  const { t } = useTranslation()
  const { resetRecoveryPhrase } = useAuth()
  const step = useSecureWizardStore((store) => store.state.step)
  const errorKey = useSecureWizardStore((store) => store.errorKey)
  const choose = useSecureWizardStore((store) => store.choose)
  const close = useSecureWizardStore((store) => store.close)
  const setStepStatus = useSecureWizardStore((store) => store.setStepStatus)
  const setPendingRotationPhrase = useUiStore((store) => store.setPendingRotationPhrase)
  const setRotationBusy = useUiStore((store) => store.setRotationBusy)
  const [password, setPassword] = useState('')

  const handleReset = async () => {
    if (password.length < 1) return

    const currentPassword = password
    // Credentials never survive the transition into the running step.
    setPassword('')
    choose('next')
    setStepStatus('running')
    setRotationBusy(true)

    try {
      const result = await resetRecoveryPhrase(currentPassword)
      if (!result.success) {
        setStepStatus('error', RESET_FALLBACK_ERROR)
        return
      }
      if (!result.mnemonic) {
        // The vault changed but the only copy of the new words is unavailable.
        // Keep this as an in-wizard hard warning, never a transient toast.
        setStepStatus('error', RESET_NO_PHRASE_ERROR)
        return
      }

      setPendingRotationPhrase(result.mnemonic, true)
      setStepStatus('done')

      // Advance on a separate tick without closing. The App-level reveal modal
      // owns the screen now; the shell interlock hides this wizard until the
      // user confirms the only surviving mnemonic.
      window.setTimeout(() => {
        useSecureWizardStore.getState().choose('next')
      }, 0)
    } catch {
      setStepStatus('error', RESET_FALLBACK_ERROR)
    } finally {
      setRotationBusy(false)
    }
  }

  useEffect(() => {
    // Password is only valid at reset_confirm; clear on any other step so it
    // never survives navigation away from that screen (plan decision #8).
    if (step !== 'reset_confirm') {
      setPassword('')
    }
  }, [step])

  switch (step) {
    case 'words_leaked':
      return render({
        description: t('settings:security.secure_wizard.words.body'),
        content: (
          <div className="flex flex-col gap-4">
            <div className="flex justify-center">
              <WizardDiagram
                variant="phrase-new"
                ariaLabel={t('settings:security.secure_wizard.diagrams.phrase_new')}
              />
            </div>
            <Callout tone="warning">
              <p className="leading-relaxed">{t('settings:security.reset.forward_only')}</p>
              <p className="mt-2 leading-relaxed">{t('settings:security.reset.other_devices')}</p>
            </Callout>
          </div>
        ),
        primaryAction: {
          label: t('settings:security.reset.confirm'),
          onClick: () => choose('next'),
          variant: 'destructive',
        },
      })

    case 'reset_confirm':
      return render({
        description: t('settings:security.secure_wizard.words.reset_body'),
        content: (
          <div className="flex flex-col gap-1">
            <label className="text-fg-muted text-xs font-medium">
              {t('settings:security.reset.password_label')}
            </label>
            <PasswordInput
              value={password}
              onChange={setPassword}
              placeholder={t('settings:security.reset.password_placeholder')}
              autoFocus
              autoComplete="current-password"
            />
          </div>
        ),
        primaryAction: {
          label: t('settings:security.reset.confirm'),
          onClick: () => void handleReset(),
          variant: 'destructive',
          disabled: password.length < 1,
        },
      })

    case 'reset_running':
      return render({
        content:
          errorKey !== null ? (
            <Callout tone="danger">{t(errorKey)}</Callout>
          ) : (
            <div className="flex flex-col items-center gap-4 py-4 text-center">
              <WizardDiagram
                variant="phrase-new"
                ariaLabel={t('settings:security.secure_wizard.diagrams.phrase_new')}
              />
              <div className="flex items-center justify-center gap-2" aria-live="polite">
                <InlineOrb state="searching" aria-hidden />
                <p className="text-fg-muted text-sm leading-relaxed">
                  {t('settings:security.secure_wizard.words.running')}
                </p>
              </div>
            </div>
          ),
        primaryAction: null,
      })

    case 'reset_done':
      return render({
        description: t('settings:security.secure_wizard.words.done_body'),
        content: (
          <div className="flex justify-center">
            <WizardDiagram
              variant="phrase-new"
              ariaLabel={t('settings:security.secure_wizard.diagrams.phrase_new')}
            />
          </div>
        ),
        primaryAction: {
          label: t('settings:security.secure_wizard.done'),
          onClick: close,
        },
      })

    default:
      return null
  }
}
