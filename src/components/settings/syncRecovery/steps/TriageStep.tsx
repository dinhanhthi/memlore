import { useTranslation } from 'react-i18next'
import { asCloudProviderKind, providerLabel } from '../../../../lib/providerLabel'
import type { SyncRecoveryWizardChoice } from '../../../../lib/syncRecoveryWizardGraph'
import { useSyncRecoveryWizardStore } from '../../../../stores/syncRecoveryWizardStore'
import { useSyncStore } from '../../../../stores/syncStore'
import { Button } from '../../../common/Button'
import type { SecureWizardStepProps } from '../../secureWizard/types'

type TriageChoice = Extract<
  SyncRecoveryWizardChoice,
  'sync_stuck' | 'device_wrong' | 'cloud_wrong' | 'stop_syncing'
>

interface TriageOption {
  choice: TriageChoice
  titleKey: string
  hintKey: string
}

const OPTIONS: TriageOption[] = [
  {
    choice: 'sync_stuck',
    titleKey: 'gdrive.recovery_wizard.triage.stuck_title',
    hintKey: 'gdrive.recovery_wizard.triage.stuck_hint',
  },
  {
    choice: 'device_wrong',
    titleKey: 'gdrive.recovery_wizard.triage.device_wrong_title',
    hintKey: 'gdrive.recovery_wizard.triage.device_wrong_hint',
  },
  {
    choice: 'cloud_wrong',
    titleKey: 'gdrive.recovery_wizard.triage.cloud_wrong_title',
    hintKey: 'gdrive.recovery_wizard.triage.cloud_wrong_hint',
  },
  {
    choice: 'stop_syncing',
    titleKey: 'gdrive.recovery_wizard.triage.stop_title',
    hintKey: 'gdrive.recovery_wizard.triage.stop_hint',
  },
]

export function TriageStep({ render }: SecureWizardStepProps) {
  const { t } = useTranslation('settings')
  const rawProvider = useSyncStore((store) => store.status?.provider ?? null)
  const i18nProvider = { provider: providerLabel(asCloudProviderKind(rawProvider), t) }
  const choose = useSyncRecoveryWizardStore((store) => store.choose)

  return render({
    description: t('gdrive.recovery_wizard.triage.question'),
    content: (
      <div className="grid gap-3">
        {OPTIONS.map(({ choice, titleKey, hintKey }) => (
          <Button
            key={choice}
            variant="secondary"
            size="sm"
            className="h-auto w-full items-start justify-start rounded-xl px-4 py-3 text-left whitespace-normal"
            onClick={() => choose(choice)}
            data-testid={`gdrive-recovery-triage-${choice}`}
          >
            <span className="flex min-w-0 flex-col gap-1">
              <span className="text-fg text-sm leading-snug font-semibold">
                {t(titleKey, i18nProvider)}
              </span>
              <span className="text-fg-muted text-xs leading-relaxed font-normal">
                {t(hintKey, i18nProvider)}
              </span>
            </span>
          </Button>
        ))}
      </div>
    ),
    primaryAction: null,
  })
}
