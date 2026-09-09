import { openUrl } from '@tauri-apps/plugin-opener'
import { CheckCircle } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useForceRePairStore } from '../../../../hooks/useForceRePair'
import { useWizardRevoke, type WizardRevokeArgs } from '../../../../hooks/useWizardRevoke'
import { providerLabel } from '../../../../lib/providerLabel'
import { gdriveDisconnect } from '../../../../lib/tauri'
import { useGdriveConnectStore } from '../../../../stores/gdriveConnectStore'
import { useSecureWizardStore } from '../../../../stores/secureWizardStore'
import { useSyncStore } from '../../../../stores/syncStore'
import { useTabStore } from '../../../../stores/tabStore'
import { useUiStore } from '../../../../stores/uiStore'
import { Button } from '../../../common/Button'
import { Callout } from '../../../common/Callout'
import { PasswordInput } from '../../../common/PasswordInput'
import { CloudAccessGuidance } from '../CloudAccessGuidance'
import {
  RevokeCredentialFields,
  type RevokeCredentialValues,
} from '../fields/RevokeCredentialFields'
import type { SecureWizardStepProps } from '../types'
import { WizardDiagram } from '../WizardDiagram'

const GOOGLE_PERMISSIONS_URL = 'https://myaccount.google.com/permissions'
const GENERIC_ERROR_KEY = 'settings:security.secure_wizard.errors.generic'
const GENERIC_CONNECT_ERROR_KEY = 'auth:onboarding.drive.error_generic'

type DisconnectStatus = 'idle' | 'running' | 'done' | 'error'

const EMPTY_REVOKE_CREDENTIALS: RevokeCredentialValues = {
  phrase: '',
  password: '',
  confirmText: '',
  isValid: false,
}

interface CutoffRevokeStepProps extends SecureWizardStepProps {
  deviceId: string
  errorKey: string | null
  running: boolean
  run: (args: WizardRevokeArgs) => Promise<void>
}

function CutoffRevokeStep({ deviceId, errorKey, running, run, render }: CutoffRevokeStepProps) {
  const { t } = useTranslation()
  const [credentials, setCredentials] = useState<RevokeCredentialValues>(EMPTY_REVOKE_CREDENTIALS)
  const [fieldsKey, setFieldsKey] = useState(0)

  const handleRevoke = async () => {
    if (!credentials.isValid) return
    const args = {
      deviceId,
      password: credentials.password,
      phrase: credentials.phrase,
    }
    setCredentials(EMPTY_REVOKE_CREDENTIALS)
    setFieldsKey((key) => key + 1)
    await run(args)
  }

  return render({
    description: t('settings:security.secure_wizard.cutoff.step1_body'),
    content: (
      <div className="flex flex-col gap-4">
        <RevokeCredentialFields key={fieldsKey} onChange={setCredentials} disabled={running} />
        {errorKey && (
          <p role="alert" className="text-danger-text text-sm leading-relaxed">
            {t(errorKey)}
          </p>
        )}
      </div>
    ),
    primaryAction: {
      label: running
        ? t('settings:security.secure_wizard.revoke.running')
        : t('settings:security.revoke.revoke'),
      onClick: () => void handleRevoke(),
      variant: 'destructive',
      disabled: !credentials.isValid,
      loading: running,
    },
  })
}

function CutoffReconnectStep({ render }: SecureWizardStepProps) {
  const { t } = useTranslation()
  const { t: tSettings } = useTranslation('settings')
  const choose = useSecureWizardStore((store) => store.choose)
  const close = useSecureWizardStore((store) => store.close)
  const setStepStatus = useSecureWizardStore((store) => store.setStepStatus)
  const connectStatus = useGdriveConnectStore((store) => store.status)
  const connectPhase = useGdriveConnectStore((store) => store.phase)
  const connectErrorKey = useGdriveConnectStore((store) => store.errorKey)
  const connectTarget = useGdriveConnectStore((store) => store.target)
  const i18nProvider = { provider: providerLabel(connectTarget?.provider ?? 'gdrive', tSettings) }
  const [password, setPassword] = useState('')
  const passwordId = useId()

  const handleConnect = async () => {
    if (password.length < 1 || connectStatus === 'connecting') return

    const currentPassword = password
    setPassword('')
    setStepStatus('running')
    await useGdriveConnectStore.getState().connect(currentPassword)

    const result = useGdriveConnectStore.getState()
    if (result.status === 'success') {
      result.acknowledgeResult()
      setStepStatus('done')
      choose('next')
      return
    }

    if (useForceRePairStore.getState().forceRePairRequired) {
      setStepStatus('idle')
      close()
      return
    }

    if (result.status === 'error') {
      setStepStatus('error', result.errorKey ?? GENERIC_ERROR_KEY)
      return
    }

    setStepStatus('idle')
  }

  const handleSkip = () => {
    setPassword('')
    choose('next')
  }

  const openSyncSettings = () => {
    setPassword('')
    useTabStore.getState().updateActiveTab({ settingsCategory: 'sync' })
    close()
  }

  const connecting = connectStatus === 'connecting'
  const phaseKey = connectPhase ? (`auth:onboarding.drive.progress.${connectPhase}` as const) : null

  return render({
    description: t('settings:security.secure_wizard.cutoff.step3_body'),
    content: (
      <div className="flex flex-col gap-4">
        <div className="flex justify-center">
          <WizardDiagram
            variant="cloud-cut"
            ariaLabel={t('settings:security.secure_wizard.diagrams.cloud_cut')}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={passwordId} className="text-fg-muted text-xs font-medium">
            {t('settings:security.secure_wizard.cutoff.password_label')}
          </label>
          <PasswordInput
            id={passwordId}
            value={password}
            onChange={setPassword}
            placeholder={t('settings:security.secure_wizard.cutoff.password_placeholder')}
            disabled={connecting}
            autoFocus
            autoComplete="current-password"
          />
        </div>
        {phaseKey && (
          <p aria-live="polite" className="text-fg-muted text-sm">
            {t(phaseKey)}
          </p>
        )}
        {connectErrorKey && (
          <div className="flex flex-col gap-3">
            <p role="alert" className="text-danger-text text-sm leading-relaxed">
              {t(connectErrorKey, i18nProvider)}
            </p>
            {connectErrorKey === GENERIC_CONNECT_ERROR_KEY && (
              <Button variant="secondary" size="xs" onClick={openSyncSettings}>
                {t('settings:security.secure_wizard.cutoff.step3_open_sync_settings')}
              </Button>
            )}
          </div>
        )}
        {!connecting && (
          <Button variant="ghost" size="xs" onClick={handleSkip} className="self-start">
            {t('settings:security.secure_wizard.cutoff.skip')}
          </Button>
        )}
      </div>
    ),
    primaryAction: {
      label: connecting
        ? t('settings:security.secure_wizard.cutoff.connecting')
        : t('settings:security.secure_wizard.cutoff.connect'),
      onClick: () => void handleConnect(),
      disabled: password.length < 1,
      loading: connecting,
    },
  })
}

export function CutoffSteps({ render }: SecureWizardStepProps) {
  const { t } = useTranslation()
  const state = useSecureWizardStore((store) => store.state)
  const choose = useSecureWizardStore((store) => store.choose)
  const close = useSecureWizardStore((store) => store.close)
  const setStepStatus = useSecureWizardStore((store) => store.setStepStatus)
  const rotationBusy = useUiStore((store) => store.rotationBusy)
  const { status: revokeStatus, errorKey: revokeErrorKey, run: runRevoke } = useWizardRevoke()
  const revokeAdvancedRef = useRef(false)
  const [disconnectStatus, setDisconnectStatus] = useState<DisconnectStatus>('idle')
  const [googleRemoved, setGoogleRemoved] = useState(false)
  const [googleOpenFailed, setGoogleOpenFailed] = useState(false)
  const [guidanceProvider] = useState(() => useSyncStore.getState().status?.provider ?? null)

  useEffect(() => {
    if (state.step !== 'cutoff_1' || revokeStatus !== 'done' || revokeAdvancedRef.current) {
      return
    }
    revokeAdvancedRef.current = true
    setStepStatus('done')
    choose('next')
  }, [choose, revokeStatus, setStepStatus, state.step])

  const handleDisconnect = async () => {
    if (disconnectStatus === 'running') return
    setDisconnectStatus('running')
    setStepStatus('running')
    try {
      await gdriveDisconnect()
      await useSyncStore.getState().refresh()
      setDisconnectStatus('done')
      setStepStatus('done')
    } catch {
      setDisconnectStatus('error')
      setStepStatus('error', GENERIC_ERROR_KEY)
    }
  }

  const handleOpenGoogle = async () => {
    setGoogleOpenFailed(false)
    try {
      await openUrl(GOOGLE_PERMISSIONS_URL)
    } catch {
      setGoogleOpenFailed(true)
    }
  }

  const step1Status = state.cutoffEnteredLate ? 'done' : revokeStatus
  const canContinueFromStep2 =
    disconnectStatus === 'done' && googleRemoved && step1Status === 'done' && !rotationBusy

  switch (state.step) {
    case 'cutoff_1':
      if (!state.targetDevice) {
        return render({
          content: (
            <p role="alert" className="text-danger-text text-sm leading-relaxed">
              {t(GENERIC_ERROR_KEY)}
            </p>
          ),
          primaryAction: null,
        })
      }
      return (
        <CutoffRevokeStep
          deviceId={state.targetDevice.id}
          errorKey={revokeErrorKey}
          running={revokeStatus === 'running'}
          run={runRevoke}
          render={render}
        />
      )

    case 'cutoff_2':
      return render({
        description: t('settings:security.secure_wizard.cutoff.step2_body'),
        content: (
          <div className="flex flex-col gap-4">
            <div className="flex justify-center">
              <WizardDiagram
                variant="cloud-cut"
                ariaLabel={t('settings:security.secure_wizard.diagrams.cloud_cut')}
              />
            </div>

            <Callout tone="warning">
              <p className="leading-relaxed">
                {t('settings:security.secure_wizard.cutoff.step2_not_sufficient')}
              </p>
              <p className="mt-2 leading-relaxed">
                {t('settings:security.secure_wizard.cutoff.step2_no_delete_reassurance')}
              </p>
            </Callout>

            <Button
              variant="secondary"
              size="xs"
              onClick={() => void handleDisconnect()}
              loading={disconnectStatus === 'running'}
              disabled={disconnectStatus === 'done' || disconnectStatus === 'running'}
              icon={
                disconnectStatus === 'done' ? (
                  <CheckCircle className="text-success size-4" strokeWidth={1.75} />
                ) : undefined
              }
              className="self-start"
            >
              {t(
                disconnectStatus === 'done'
                  ? 'settings:security.secure_wizard.cutoff.disconnect_done'
                  : 'settings:security.secure_wizard.cutoff.disconnect_button',
              )}
            </Button>
            {disconnectStatus === 'error' && (
              <p role="alert" className="text-danger-text text-sm">
                {t(GENERIC_ERROR_KEY)}
              </p>
            )}

            <Button
              variant="secondary"
              size="xs"
              onClick={() => void handleOpenGoogle()}
              className="self-start"
            >
              {t('settings:security.secure_wizard.cutoff.open_google_button')}
            </Button>
            {googleOpenFailed && (
              <p role="alert" className="text-danger-text text-sm">
                {t(GENERIC_ERROR_KEY)}
              </p>
            )}
            <CloudAccessGuidance provider={guidanceProvider} />

            <label className="text-fg flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={googleRemoved}
                onChange={(event) => setGoogleRemoved(event.target.checked)}
                className="border-border-default accent-accent mt-0.5 size-4 rounded"
              />
              <span>{t('settings:security.secure_wizard.cutoff.step2_confirm_gate')}</span>
            </label>
          </div>
        ),
        primaryAction: {
          label: t('settings:security.secure_wizard.cutoff.step3_title'),
          onClick: () => choose('next'),
          disabled: !canContinueFromStep2,
        },
      })

    case 'cutoff_3':
      return <CutoffReconnectStep render={render} />

    case 'cutoff_done':
      return render({
        description: t('settings:security.secure_wizard.cutoff.done_body'),
        content: (
          <div className="flex justify-center">
            <WizardDiagram
              variant="cloud-cut"
              ariaLabel={t('settings:security.secure_wizard.diagrams.cloud_cut')}
            />
          </div>
        ),
        primaryAction: state.needsPhraseReset
          ? {
              label: t('settings:security.secure_wizard.chain.next_words_reset'),
              onClick: () => choose('next'),
            }
          : {
              label: t('settings:security.secure_wizard.done'),
              onClick: close,
            },
      })

    default:
      return null
  }
}
