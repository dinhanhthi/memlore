import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDeviceList } from '../../../../hooks/useDeviceList'
import { useWizardRemove } from '../../../../hooks/useWizardRemove'
import { useWizardRevoke, type WizardRevokeArgs } from '../../../../hooks/useWizardRevoke'
import { useSecureWizardStore } from '../../../../stores/secureWizardStore'
import { useSyncStore } from '../../../../stores/syncStore'
import { useUiStore } from '../../../../stores/uiStore'
import { Button } from '../../../common/Button'
import { Callout } from '../../../common/Callout'
import { InlineOrb } from '../../../common/ThinkingOrb'
import { CloudAccessGuidance } from '../CloudAccessGuidance'
import {
  RevokeCredentialFields,
  type RevokeCredentialValues,
} from '../fields/RevokeCredentialFields'
import type { SecureWizardStepProps } from '../types'

const EMPTY_CREDENTIALS: RevokeCredentialValues = {
  phrase: '',
  password: '',
  confirmText: '',
  isValid: false,
}

const REVOKE_FACT_KEYS = [
  'settings:security.secure_wizard.revoke.done_fact_new_entries',
  'settings:security.secure_wizard.revoke.done_fact_old_data',
  'settings:security.secure_wizard.revoke.done_fact_cloud_access',
] as const

const REMOVE_FACT_KEYS = [
  'settings:security.secure_wizard.remove.done_fact_list',
  'settings:security.secure_wizard.remove.done_fact_unchanged',
  'settings:security.secure_wizard.remove.done_fact_reappear',
] as const

export function DeviceBranchSteps({ render }: SecureWizardStepProps) {
  const { t } = useTranslation()
  const { devices, loading, error } = useDeviceList()
  const syncStatus = useSyncStore((store) => store.status)
  const isSyncing = useSyncStore((store) => store.isSyncing)
  const state = useSecureWizardStore((store) => store.state)
  const errorKey = useSecureWizardStore((store) => store.errorKey)
  const choose = useSecureWizardStore((store) => store.choose)
  const back = useSecureWizardStore((store) => store.back)
  const close = useSecureWizardStore((store) => store.close)
  const setTargetDevice = useSecureWizardStore((store) => store.setTargetDevice)
  const setStepStatus = useSecureWizardStore((store) => store.setStepStatus)
  const revoke = useWizardRevoke()
  const remove = useWizardRemove()
  const [credentials, setCredentials] = useState<RevokeCredentialValues>(EMPTY_CREDENTIALS)
  // Global busy flag from the hook's run — outlives this component, so a
  // wizard closed and reopened mid-removal still refuses a duplicate click.
  const deviceRemovalBusy = useUiStore((store) => store.deviceRemovalBusy)

  const availableDevices = useMemo(
    () => devices.filter((device) => !device.is_current && !device.is_revoked),
    [devices],
  )
  const driveEnabled = syncStatus?.enabled === true && syncStatus.provider != null

  useEffect(() => {
    if (state.step !== 'revoke_running') return

    if (revoke.status === 'done') {
      setStepStatus('done')
      choose('next')
    } else if (revoke.status === 'error') {
      setStepStatus('error', revoke.errorKey ?? 'settings:security.secure_wizard.errors.generic')
    }
  }, [choose, revoke.errorKey, revoke.status, setStepStatus, state.step])

  useEffect(() => {
    if (state.step !== 'remove_running') return

    if (remove.status === 'done') {
      setStepStatus('done')
      choose('next')
    } else if (remove.status === 'error') {
      setStepStatus('error', remove.errorKey ?? 'settings:security.secure_wizard.errors.generic')
    }
  }, [choose, remove.errorKey, remove.status, setStepStatus, state.step])

  useEffect(() => {
    // Recovery phrase + password are only valid at revoke_confirm. Clear on
    // any other step so they never survive navigation away from that screen
    // (plan decision #8: password never cached across steps).
    if (state.step !== 'revoke_confirm') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- security guard: clear sensitive credentials when leaving the entry step
      setCredentials(EMPTY_CREDENTIALS)
    }
  }, [state.step])

  const selectDevice = (device: (typeof availableDevices)[number]) => {
    setTargetDevice({ id: device.device_id, name: device.name })
    choose('next')
  }

  const goToRoutineRotation = () => {
    // The graph intentionally routes Back from the picker to triage. Reuse
    // those public transitions so the empty state can enter the routine branch
    // without mutating wizard state directly.
    back()
    choose('routine_rotation')
  }

  const handleRevoke = () => {
    if (!state.targetDevice || !credentials.isValid) return

    const args: WizardRevokeArgs = {
      deviceId: state.targetDevice.id,
      password: credentials.password,
      phrase: credentials.phrase,
    }
    setCredentials(EMPTY_CREDENTIALS)
    // Kick off first so rotationBusy is set before the dialog unmounts, then
    // close immediately — the run continues after this component is gone.
    void revoke.run(args)
    close()
  }

  const handleRemove = () => {
    if (!state.targetDevice || deviceRemovalBusy) return

    const deviceId = state.targetDevice.id
    // Same fire-and-forget as rename: busy flag is set synchronously inside
    // run(), then the wizard closes so the user is not stuck on confirm while
    // the backend queues behind an in-flight sync.
    void remove.run(deviceId)
    close()
  }

  switch (state.step) {
    case 'device_pick': {
      const showEmpty = !driveEnabled || (!loading && availableDevices.length === 0)

      return render({
        description: t('settings:security.secure_wizard.device.picker_title'),
        content: (
          <div className="flex flex-col gap-4">
            {driveEnabled && loading && (
              <p aria-live="polite" className="text-fg-muted text-sm">
                {t('settings:security.devices.refreshing')}
              </p>
            )}

            {driveEnabled && error && (
              <p role="alert" className="text-danger-text text-sm">
                {t('settings:security.secure_wizard.errors.generic')}
              </p>
            )}

            {driveEnabled && availableDevices.length > 0 && (
              <div className="grid gap-2">
                {availableDevices.map((device) => (
                  <Button
                    key={device.device_id}
                    variant="secondary"
                    size="xs"
                    className="h-auto w-full justify-start rounded-xl px-4 py-3 text-left whitespace-normal"
                    aria-label={t('settings:security.secure_wizard.device.select', {
                      device: device.name,
                    })}
                    onClick={() => selectDevice(device)}
                  >
                    <span className="text-fg text-sm font-semibold">{device.name}</span>
                  </Button>
                ))}
              </div>
            )}

            {showEmpty && (
              <div className="border-border-default flex flex-col gap-3 rounded-2xl border p-4">
                <p className="text-fg-muted text-sm leading-relaxed">
                  {t('settings:security.secure_wizard.device.picker_empty')}
                </p>
                <Button
                  variant="secondary"
                  size="xs"
                  className="self-start"
                  onClick={goToRoutineRotation}
                >
                  {t('settings:security.secure_wizard.device.picker_empty_routine')}
                </Button>
              </div>
            )}
          </div>
        ),
        primaryAction: null,
      })
    }

    case 'device_words':
      return render({
        description: t('settings:security.secure_wizard.device.words_question'),
        content: (
          <div className="grid gap-2">
            <Button
              variant="secondary"
              size="xs"
              className="h-auto justify-start rounded-xl px-4 py-3 text-left whitespace-normal"
              onClick={() => choose('phrase_leaked')}
            >
              {t('settings:security.secure_wizard.device.words_yes')}
            </Button>
            <Button
              variant="secondary"
              size="xs"
              className="h-auto justify-start rounded-xl px-4 py-3 text-left whitespace-normal"
              onClick={() => choose('phrase_safe')}
            >
              {t('settings:security.secure_wizard.device.words_no')}
            </Button>
            <Button
              variant="secondary"
              size="xs"
              className="h-auto items-start justify-start rounded-xl px-4 py-3 text-left whitespace-normal"
              onClick={() => choose('just_remove')}
            >
              <span className="flex min-w-0 flex-col gap-1">
                <span className="text-fg text-sm leading-snug font-semibold">
                  {t('settings:security.secure_wizard.device.words_remove_title')}
                </span>
                <span className="text-fg-muted text-xs leading-relaxed font-normal">
                  {t('settings:security.secure_wizard.device.words_remove_hint')}
                </span>
              </span>
            </Button>
          </div>
        ),
        primaryAction: null,
      })

    case 'device_scope':
      return render({
        description: t('settings:security.secure_wizard.device.scope_title'),
        content: (
          <div className="grid gap-3">
            <Button
              variant="secondary"
              size="xs"
              className="h-auto items-start justify-start rounded-xl px-4 py-3 text-left whitespace-normal"
              onClick={() => choose('revoke_only')}
            >
              <span className="flex min-w-0 flex-col gap-1">
                <span className="text-fg text-sm leading-snug font-semibold">
                  {t('settings:security.secure_wizard.device.scope_revoke_title')}
                </span>
                <span className="text-fg-muted text-xs leading-relaxed font-normal">
                  {t('settings:security.secure_wizard.device.scope_revoke_hint')}
                </span>
              </span>
            </Button>
            <Button
              variant="secondary"
              size="xs"
              className="h-auto items-start justify-start rounded-xl px-4 py-3 text-left whitespace-normal"
              onClick={() => choose('cutoff_google')}
            >
              <span className="flex min-w-0 flex-col gap-1">
                <span className="text-fg text-sm leading-snug font-semibold">
                  {t('settings:security.secure_wizard.device.scope_cutoff_title')}
                </span>
                <span className="text-fg-muted text-xs leading-relaxed font-normal">
                  {t('settings:security.secure_wizard.device.scope_cutoff_hint')}
                </span>
              </span>
            </Button>
          </div>
        ),
        primaryAction: null,
      })

    case 'revoke_confirm':
      return render({
        description: t('settings:security.secure_wizard.revoke.confirm_body', {
          device: state.targetDevice?.name ?? '',
        }),
        content: <RevokeCredentialFields onChange={setCredentials} />,
        primaryAction: {
          label: t('settings:security.devices.revoke'),
          onClick: handleRevoke,
          variant: 'destructive',
          disabled: !state.targetDevice || !credentials.isValid,
        },
      })

    case 'revoke_running':
      return render({
        content:
          errorKey !== null ? (
            <Callout tone="danger">{t(errorKey)}</Callout>
          ) : (
            <div className="flex flex-col items-center gap-3 py-5 text-center">
              <div className="flex items-center justify-center gap-2" aria-live="polite">
                <InlineOrb state="searching" aria-hidden />
                <p className="text-fg-muted text-sm leading-relaxed">
                  {t('settings:security.secure_wizard.revoke.running')}
                </p>
              </div>
            </div>
          ),
        primaryAction: null,
      })

    case 'revoke_done':
      return render({
        description: t('settings:security.secure_wizard.revoke.done_title'),
        content: (
          <div className="flex flex-col gap-4">
            <ul className="text-fg-muted flex list-disc flex-col gap-2 ps-5 text-sm leading-relaxed">
              {REVOKE_FACT_KEYS.map((key) => (
                <li key={key}>{t(key)}</li>
              ))}
            </ul>
            <CloudAccessGuidance />
          </div>
        ),
        primaryAction: state.needsPhraseReset
          ? {
              label: t('settings:security.secure_wizard.chain.next_words_reset'),
              onClick: () => choose('next'),
            }
          : {
              label: t('settings:security.secure_wizard.revoke.cutoff_google'),
              onClick: () => choose('cutoff_google'),
            },
      })

    case 'remove_confirm':
      return render({
        description: (
          <>
            <p className="m-0">{t('settings:security.secure_wizard.remove.confirm_body')}</p>
            <p className="m-0 mt-1">
              {t('settings:security.secure_wizard.remove.confirm_reappear')}
            </p>
          </>
        ),
        content: null,
        primaryAction: {
          label: t('settings:security.secure_wizard.remove.confirm_button'),
          onClick: handleRemove,
          variant: 'destructive',
          disabled: !state.targetDevice || deviceRemovalBusy,
          tooltip: deviceRemovalBusy
            ? t('settings:security.secure_wizard.remove.busy_other')
            : undefined,
        },
      })

    case 'remove_running':
      return render({
        content:
          errorKey !== null ? (
            <Callout tone="danger">{t(errorKey)}</Callout>
          ) : (
            <div className="flex flex-col items-center gap-3 py-5 text-center">
              <div className="flex items-center justify-center gap-2" aria-live="polite">
                <InlineOrb state="searching" aria-hidden />
                <p className="text-fg-muted text-sm leading-relaxed">
                  {/* A sync can also grab the guard between confirm-click and
                      backend acquire — surface the queued copy there too. */}
                  {isSyncing
                    ? t('settings:security.secure_wizard.remove.queued_sync')
                    : t('settings:security.secure_wizard.remove.running')}
                </p>
              </div>
            </div>
          ),
        primaryAction: null,
      })

    case 'remove_done':
      return render({
        description: t('settings:security.secure_wizard.remove.done_title'),
        content: (
          <ul className="text-fg-muted flex list-disc flex-col gap-2 ps-5 text-sm leading-relaxed">
            {REMOVE_FACT_KEYS.map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ul>
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
