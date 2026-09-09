import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { asCloudProviderKind, providerLabel } from '../../../../lib/providerLabel'
import type { SyncRecoveryWizardChoice } from '../../../../lib/syncRecoveryWizardGraph'
import { gdriveDisconnect, gdriveWipeCloud } from '../../../../lib/tauri'
import { useSyncRecoveryWizardStore } from '../../../../stores/syncRecoveryWizardStore'
import { useSyncStore } from '../../../../stores/syncStore'
import { Button } from '../../../common/Button'
import { Callout } from '../../../common/Callout'
import { InlineOrb } from '../../../common/ThinkingOrb'
import type { SecureWizardPrimaryAction, SecureWizardStepProps } from '../../secureWizard/types'

type StopChoice = Extract<SyncRecoveryWizardChoice, 'keep_cloud' | 'delete_cloud'>

interface StopOption {
  choice: StopChoice
  titleKey: string
  hintKey: string
}

const STOP_OPTIONS: StopOption[] = [
  {
    choice: 'keep_cloud',
    titleKey: 'gdrive.recovery_wizard.stop.keep_title',
    hintKey: 'gdrive.recovery_wizard.stop.keep_hint',
  },
  {
    choice: 'delete_cloud',
    titleKey: 'gdrive.recovery_wizard.stop.delete_title',
    hintKey: 'gdrive.recovery_wizard.stop.delete_hint',
  },
]

export interface StopStepsProps extends SecureWizardStepProps {
  onStatusChanged: () => Promise<void>
}

export function StopSteps({ render, onStatusChanged }: StopStepsProps) {
  const { t } = useTranslation('settings')
  const rawProvider = useSyncStore((store) => store.status?.provider ?? null)
  const providerKind = asCloudProviderKind(rawProvider)
  const i18nProvider = { provider: providerLabel(providerKind, t) }
  const step = useSyncRecoveryWizardStore((store) => store.state.step)
  const stepStatus = useSyncRecoveryWizardStore((store) => store.stepStatus)
  const error = useSyncRecoveryWizardStore((store) => store.error)
  const choose = useSyncRecoveryWizardStore((store) => store.choose)
  const back = useSyncRecoveryWizardStore((store) => store.back)
  const close = useSyncRecoveryWizardStore((store) => store.close)
  const [actionLocked, setActionLocked] = useState(false)
  const inFlightRef = useRef(false)

  const errorBackAction: SecureWizardPrimaryAction = {
    label: t('gdrive.recovery_wizard.back'),
    onClick: back,
    variant: 'secondary',
  }

  const handleDisconnect = async () => {
    if (inFlightRef.current) return
    const store = useSyncRecoveryWizardStore.getState()
    if (store.state.step !== 'disconnect_confirm' || store.stepStatus === 'running') return

    inFlightRef.current = true
    setActionLocked(true)
    store.choose('next')
    store.setStepStatus('running')

    try {
      await gdriveDisconnect()
      await useSyncStore.getState().refresh()
      await onStatusChanged()
      store.setStepStatus('done')
      store.choose('next')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      store.setStepStatus(
        'error',
        message === 'sync_in_progress'
          ? t('gdrive.help.delete_and_disconnect.error_sync_in_progress')
          : t('gdrive.recovery_wizard.errors.generic'),
      )
      inFlightRef.current = false
      setActionLocked(false)
    }
  }

  const handleDelete = async () => {
    if (inFlightRef.current) return
    const store = useSyncRecoveryWizardStore.getState()
    if (store.state.step !== 'delete_confirm' || store.stepStatus === 'running') return

    inFlightRef.current = true
    setActionLocked(true)
    store.choose('next')
    store.setStepStatus('running')

    try {
      await gdriveWipeCloud(true)
      await useSyncStore.getState().refresh()
      await onStatusChanged()
      store.setStepStatus('done')
      store.choose('next')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      store.setStepStatus(
        'error',
        message === 'sync_in_progress'
          ? t('gdrive.help.delete_and_disconnect.error_sync_in_progress')
          : t('gdrive.help.delete_and_disconnect.error', { message, ...i18nProvider }),
      )
      inFlightRef.current = false
      setActionLocked(false)
    }
  }

  switch (step) {
    case 'stop_choice':
      return render({
        description: t('gdrive.recovery_wizard.stop.question', i18nProvider),
        content: (
          <div className="grid gap-3">
            {STOP_OPTIONS.map(({ choice, titleKey, hintKey }) => (
              <Button
                key={choice}
                variant="secondary"
                size="sm"
                className="h-auto w-full items-start justify-start rounded-xl px-4 py-3 text-left whitespace-normal"
                onClick={() => choose(choice)}
                data-testid={`gdrive-recovery-stop-${choice}`}
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

    case 'disconnect_confirm':
      return render({
        description: (
          <>
            {t('gdrive.disconnect_modal.body')}
            {providerKind === 'gdrive' ? (
              <span className="mt-2 block">{t('gdrive.disconnect_modal.body_gdrive_note')}</span>
            ) : null}
          </>
        ),
        content: (
          <p className="text-fg text-sm leading-snug font-semibold">
            {t('gdrive.disconnect_modal.title', i18nProvider)}
          </p>
        ),
        primaryAction: {
          label: t('gdrive.disconnect_modal.confirm'),
          onClick: () => {
            void handleDisconnect()
          },
          variant: 'secondary',
          disabled: actionLocked,
        },
      })

    case 'disconnect_running':
      if (stepStatus === 'error' && error) {
        return render({
          content: <Callout tone="danger">{error}</Callout>,
          primaryAction: errorBackAction,
        })
      }

      return render({
        content: (
          <div className="flex flex-col items-center gap-3 py-5 text-center">
            <div className="flex items-center justify-center gap-2" aria-live="polite">
              <InlineOrb state="searching" aria-hidden />
              <p className="text-fg-muted text-sm leading-relaxed">
                {t('gdrive.recovery_wizard.disconnect.running', i18nProvider)}
              </p>
            </div>
          </div>
        ),
        primaryAction: null,
      })

    case 'disconnect_done':
      return render({
        content: (
          <p className="text-fg text-sm leading-relaxed">
            {t('gdrive.recovery_wizard.disconnect.done', i18nProvider)}
          </p>
        ),
        primaryAction: {
          label: t('gdrive.recovery_wizard.done'),
          onClick: close,
        },
      })

    case 'delete_confirm':
      return render({
        description: t('gdrive.help.delete_and_disconnect.modal_body', i18nProvider),
        content: (
          <div className="flex flex-col gap-3">
            <p className="text-fg text-sm leading-snug font-semibold">
              {t('gdrive.help.delete_and_disconnect.modal_title', i18nProvider)}
            </p>
            <Callout tone="danger" title={t('gdrive.help.delete_and_disconnect.backup_warning')} />
          </div>
        ),
        primaryAction: {
          label: t('gdrive.help.delete_and_disconnect.modal_confirm'),
          onClick: () => {
            void handleDelete()
          },
          variant: 'destructive',
          disabled: actionLocked,
        },
      })

    case 'delete_running':
      if (stepStatus === 'error' && error) {
        return render({
          content: <Callout tone="danger">{error}</Callout>,
          primaryAction: errorBackAction,
        })
      }

      return render({
        content: (
          <div className="flex flex-col items-center gap-3 py-5 text-center">
            <div className="flex items-center justify-center gap-2" aria-live="polite">
              <InlineOrb state="searching" aria-hidden />
              <p className="text-fg-muted text-sm leading-relaxed">
                {t('gdrive.recovery_wizard.delete.running', i18nProvider)}
              </p>
            </div>
          </div>
        ),
        primaryAction: null,
      })

    case 'delete_done':
      return render({
        content: (
          <p className="text-fg text-sm leading-relaxed">
            {t('gdrive.help.delete_and_disconnect.success', i18nProvider)}
          </p>
        ),
        primaryAction: {
          label: t('gdrive.recovery_wizard.done'),
          onClick: close,
        },
      })

    default:
      return null
  }
}
