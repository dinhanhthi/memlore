import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../../../lib/cn'
import { asCloudProviderKind, providerLabel } from '../../../../lib/providerLabel'
import {
  recoveryBlockerMessage,
  toRecoveryDirection,
  type RecoveryDirection,
} from '../../../../lib/recoveryBlockerMessage'
import { useSyncRecoveryWizardStore } from '../../../../stores/syncRecoveryWizardStore'
import { useSyncStore } from '../../../../stores/syncStore'
import type { SecureWizardStepProps } from '../../secureWizard/types'

type PreflightUi = 'checking' | 'ready' | 'blocked'

export interface ReplaceStepsProps extends SecureWizardStepProps {
  onRecoveryConfirmed: (direction: RecoveryDirection) => Promise<void>
}

/** StrictMode remount must not cancel the job the second mount still owns. */
let replaceStepsMountGen = 0

function cancelAbandonableRecovery(): void {
  void useSyncStore.getState().cancelRecovery().catch(console.warn)
}

export function ReplaceSteps({ render, onRecoveryConfirmed }: ReplaceStepsProps) {
  const { t } = useTranslation('settings')
  const rawProvider = useSyncStore((store) => store.status?.provider ?? null)
  const i18nProvider = { provider: providerLabel(asCloudProviderKind(rawProvider), t) }
  const step = useSyncRecoveryWizardStore((store) => store.state.step)
  const close = useSyncRecoveryWizardStore((store) => store.close)
  const direction: RecoveryDirection =
    step === 'cloud_to_local_confirm' ? 'cloud_to_local' : 'local_to_cloud'
  const helpPrefix =
    direction === 'cloud_to_local' ? 'gdrive.help.cloud_to_local' : 'gdrive.help.local_to_cloud'

  const [preflightUi, setPreflightUi] = useState<PreflightUi>('checking')
  const [preflightMessage, setPreflightMessage] = useState<string | null>(null)
  const [confirmLocked, setConfirmLocked] = useState(false)
  const preflightEpochRef = useRef(0)
  const confirmedRef = useRef(false)
  const inFlightRef = useRef(false)
  const mountGenRef = useRef(0)
  if (mountGenRef.current === 0) {
    mountGenRef.current = ++replaceStepsMountGen
  }

  useEffect(() => {
    const epoch = ++preflightEpochRef.current
    const gen = mountGenRef.current
    let cancelled = false
    setPreflightUi('checking')
    setPreflightMessage(null)

    const abandonIfStale = (): boolean => {
      if (!cancelled && epoch === preflightEpochRef.current) return false
      // Stale result after Back/Esc/unmount: cancel the job this preflight
      // just hydrated. Skip if a newer mount (StrictMode remount) owns it.
      if (
        !confirmedRef.current &&
        gen === replaceStepsMountGen &&
        epoch === preflightEpochRef.current
      ) {
        cancelAbandonableRecovery()
      }
      return true
    }

    const run = async () => {
      try {
        if (direction === 'local_to_cloud') {
          await useSyncStore.getState().preflightLocalRecovery()
        } else {
          await useSyncStore.getState().beginCloudRecoveryStaging()
        }
        if (abandonIfStale()) return
        setPreflightUi('ready')
        setPreflightMessage(null)
      } catch (err) {
        if (abandonIfStale()) return
        const msg = err instanceof Error ? err.message : String(err)
        setPreflightUi('blocked')
        setPreflightMessage(msg)
      }
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [direction])

  useEffect(() => {
    const gen = mountGenRef.current
    return () => {
      queueMicrotask(() => {
        if (replaceStepsMountGen !== gen) return
        if (confirmedRef.current) return
        if (!useSyncStore.getState().recovery?.canCancelSafely) return
        cancelAbandonableRecovery()
      })
    }
  }, [])

  const blocked = recoveryBlockerMessage(preflightMessage ?? '', toRecoveryDirection(direction))

  const handleConfirm = async () => {
    if (preflightUi !== 'ready' || inFlightRef.current) return
    inFlightRef.current = true
    confirmedRef.current = true
    setConfirmLocked(true)
    close()
    await onRecoveryConfirmed(direction)
  }

  const statusText =
    preflightUi === 'checking'
      ? t(`${helpPrefix}.checking`)
      : preflightUi === 'ready'
        ? t(`${helpPrefix}.ready`, i18nProvider)
        : t(blocked.key, { ...blocked.params, ...i18nProvider })

  return render({
    description: t(`${helpPrefix}.modal_body`, i18nProvider),
    content: (
      <div className="flex flex-col gap-3">
        <p className="text-fg text-sm leading-snug font-semibold">
          {t(`${helpPrefix}.modal_title`, i18nProvider)}
        </p>
        <p
          data-testid="gdrive-recovery-preflight-status"
          className={cn(
            'text-xs',
            preflightUi === 'blocked' ? 'text-danger-text' : 'text-fg-muted',
          )}
          role={preflightUi === 'blocked' ? 'alert' : 'status'}
        >
          {statusText}
        </p>
      </div>
    ),
    primaryAction: {
      label: t(`${helpPrefix}.modal_confirm`, i18nProvider),
      onClick: () => {
        void handleConfirm()
      },
      variant: 'destructive',
      disabled: preflightUi !== 'ready' || confirmLocked,
    },
  })
}
