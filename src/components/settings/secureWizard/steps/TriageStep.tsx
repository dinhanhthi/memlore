import { useTranslation } from 'react-i18next'
import type { SecureWizardChoice } from '../../../../lib/secureWizardGraph'
import { useSecureWizardStore } from '../../../../stores/secureWizardStore'
import { Button } from '../../../common/Button'
import type { SecureWizardStepProps } from '../types'

type TriageChoice = Extract<
  SecureWizardChoice,
  'words_leaked' | 'password_leaked' | 'device_compromised' | 'routine_rotation'
>

interface TriageOption {
  choice: TriageChoice
  titleKey: string
  hintKey: string
}

const OPTIONS: TriageOption[] = [
  {
    choice: 'words_leaked',
    titleKey: 'settings:security.secure_wizard.triage.words_title',
    hintKey: 'settings:security.secure_wizard.triage.words_hint',
  },
  {
    choice: 'password_leaked',
    titleKey: 'settings:security.secure_wizard.triage.password_title',
    hintKey: 'settings:security.secure_wizard.triage.password_hint',
  },
  {
    choice: 'device_compromised',
    titleKey: 'settings:security.secure_wizard.triage.device_title',
    hintKey: 'settings:security.secure_wizard.triage.device_hint',
  },
  {
    choice: 'routine_rotation',
    titleKey: 'settings:security.secure_wizard.triage.routine_title',
    hintKey: 'settings:security.secure_wizard.triage.routine_hint',
  },
]

export function TriageStep({ render }: SecureWizardStepProps) {
  const { t } = useTranslation()
  const choose = useSecureWizardStore((store) => store.choose)

  return render({
    description: t('settings:security.secure_wizard.triage.question'),
    content: (
      <div className="grid gap-3">
        {OPTIONS.map(({ choice, titleKey, hintKey }) => (
          <Button
            key={choice}
            variant="secondary"
            size="xs"
            className="h-auto w-full items-start justify-start rounded-xl px-4 py-3 text-left whitespace-normal"
            onClick={() => choose(choice)}
          >
            <span className="flex min-w-0 flex-col gap-1">
              <span className="text-fg text-sm leading-snug font-semibold">{t(titleKey)}</span>
              <span className="text-fg-muted text-xs leading-relaxed font-normal">
                {t(hintKey)}
              </span>
            </span>
          </Button>
        ))}
      </div>
    ),
    primaryAction: null,
  })
}
