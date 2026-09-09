import { useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { KeyRound, QrCode } from 'lucide-react'
import { Button } from '../common/Button'
import { Callout } from '../common/Callout'
import { Modal } from '../common/Modal'
import { PasswordInput } from '../common/PasswordInput'
import { TextInput } from '../common/TextInput'
import { UnlockMethodPicker, type PickableMethod } from './UnlockMethodPicker'
import { useBiometricAvailability } from '../../hooks/useBiometricAvailability'
import { useRecoveryQrImport } from '../../hooks/useRecoveryQrImport'
import { MIN_PASSWORD_LEN, passwordStrength, type Strength } from '../../lib/passwordStrength'
import { BIP39_EN } from '../../lib/bip39-wordlist-en'
import { asCloudProviderKind, providerLabel } from '../../lib/providerLabel'
import * as tauri from '../../lib/tauri'
import type { CloudProviderKind } from '../../lib/tauri'
import { cn } from '../../lib/cn'
import { useSyncStore } from '../../stores/syncStore'

type Step = 'passphrase' | 'unlock_method' | 'password'

interface Props {
  onCompleted: () => void
  onCancel: () => void
  /** Optional Drive OAuth session_id. When supplied, the backend persists the
   *  four Drive sync settings atomically with the password flip. Omit for the
   *  legacy path (GoogleDriveSettings already-connected flow). */
  sessionId?: string
  /** Start on a specific wizard step (e.g. web preview harness). Defaults to passphrase. */
  initialStep?: Step
  /** `modal` lifts Back/Continue into `Modal.Footer`. `inline` keeps them
   *  under the form (WelcomeScreen). */
  chrome?: 'inline' | 'modal'
  /** Cloud the user is joining. Used for {{provider}} copy. */
  providerKind?: CloudProviderKind | null
}

const STRENGTH_STYLES: Record<Strength, { segments: number; color: string }> = {
  weak: { segments: 1, color: 'bg-danger' },
  fair: { segments: 2, color: 'bg-warning' },
  good: { segments: 3, color: 'bg-success' },
  strong: { segments: 4, color: 'bg-accent' },
}

// Derive a simple device name from the browser's navigator.platform.
function deriveDeviceName(): string {
  if (typeof navigator !== 'undefined' && navigator.platform) {
    const p = navigator.platform
    if (p.startsWith('Mac')) return 'Mac'
    if (p.startsWith('Win')) return 'Windows PC'
    if (p.startsWith('Linux')) return 'Linux PC'
  }
  return 'This device'
}

/**
 * `OnboardNewDeviceScreen` — joining a vault that already exists in the cloud.
 *
 * There are exactly two ways in, and both end at the same cloud check
 * (`onboard_validate_passphrase`): type the 24 words, or import the recovery
 * sheet's QR image. Device-to-device transfer was built and then dropped
 * (see the plan's README decision 9), so there is deliberately no pairing
 * affordance here, and no camera/live scanning — image files only.
 *
 * Steps: passphrase → unlock method → password + device name.
 *
 * The unlock-method step mirrors first-run: this device's own choice, not
 * something inherited from the vault's other devices. It reuses
 * `UnlockMethodPicker` (and therefore the "password" | "both" constraint —
 * never a device without a password fallback).
 *
 * This component is rendered inside a card (`WelcomeScreen`) or a modal body
 * (`GoogleDriveSettings`), so it renders no page chrome of its own.
 */
export function OnboardNewDeviceScreen({
  onCompleted,
  onCancel,
  sessionId,
  initialStep = 'passphrase',
  chrome = 'inline',
  providerKind,
}: Props) {
  const { t } = useTranslation('auth')
  const { t: tSettings } = useTranslation('settings')
  const statusProvider = useSyncStore((s) => asCloudProviderKind(s.status?.provider))
  const i18nProvider = {
    provider:
      providerLabel(providerKind ?? statusProvider, tSettings) ||
      tSettings('data_section.local_data_notice_provider_fallback'),
  }

  const [step, setStep] = useState<Step>(initialStep)

  // Step A state
  const [phrase, setPhrase] = useState('')
  const [isValidating, setIsValidating] = useState(false)
  const [validateError, setValidateError] = useState('')
  const qrImport = useRecoveryQrImport(sessionId)

  // Step B state
  const [unlockMethod, setUnlockMethod] = useState<PickableMethod>('password')
  const { available: biometricAvailable, loading: biometricLoading } = useBiometricAvailability()

  // Step C state
  const [validatedMnemonic, setValidatedMnemonic] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [deviceName, setDeviceName] = useState(deriveDeviceName())
  const [isFinishing, setIsFinishing] = useState(false)
  const [finishError, setFinishError] = useState('')

  // ── Step A: passphrase analysis ──────────────────────────────────────────

  const words = useMemo(() => phrase.trim().split(/\s+/).filter(Boolean), [phrase])
  const wordCount = words.length
  const unknownWords = useMemo(() => words.filter((w) => !BIP39_EN.has(w.toLowerCase())), [words])
  const passphraseReady = wordCount === 24 && unknownWords.length === 0
  const isImporting = qrImport.status.kind === 'importing'

  const handleContinue = async () => {
    if (!passphraseReady || isValidating || isImporting) return
    setIsValidating(true)
    setValidateError('')
    try {
      await tauri.onboardValidatePassphrase(phrase.trim().toLowerCase(), sessionId)
      setValidatedMnemonic(phrase.trim().toLowerCase())
      setStep('unlock_method')
    } catch (err) {
      // Tauri rejects with plain strings — without the `typeof string` branch
      // the user only sees the generic `error_fallback` ("Onboarding failed.
      // Please try again.") for every backend error, including the actionable
      // "Google Drive is not connected on this device" string that fires when
      // sessionId is missing or expired.
      const msg =
        typeof err === 'string'
          ? err
          : err instanceof Error
            ? err.message
            : t('onboard.error_fallback')
      setValidateError(msg)
    } finally {
      setIsValidating(false)
    }
  }

  // The QR route reaches the same place as the typed one: the hook decodes the
  // image AND runs the decoded phrase through `onboard_validate_passphrase`,
  // so a sheet from another vault is rejected here exactly like a typed
  // wrong phrase.
  const handleImportQr = async () => {
    if (isValidating || isImporting) return
    setValidateError('')
    const outcome = await qrImport.importFromImage()
    if (outcome.kind === 'imported') {
      setValidatedMnemonic(outcome.mnemonic)
      setStep('unlock_method')
    }
  }

  // ── Step C: password + finish ────────────────────────────────────────────

  const pwLen = [...password].length
  const strength = useMemo(() => passwordStrength(password), [password])
  const mismatched = confirm.length > 0 && password !== confirm
  const canFinish =
    pwLen >= MIN_PASSWORD_LEN && password === confirm && deviceName.trim().length > 0

  const handleFinish = async () => {
    if (!canFinish || isFinishing) return
    setIsFinishing(true)
    setFinishError('')
    try {
      await tauri.onboardComplete(
        validatedMnemonic,
        password,
        deviceName.trim(),
        sessionId,
        unlockMethod,
      )
      onCompleted()
    } catch (err) {
      // Tauri rejects with plain strings; surface the raw message so the
      // user sees backend sentinels (e.g. PENDING_DRIVE_SESSION_EXPIRED)
      // verbatim. The WelcomeScreen wrapper does the friendly
      // mapping for entry-point errors; here we just show the raw string
      // because this screen is reached only through the onboarding flow.
      const msg =
        typeof err === 'string'
          ? err
          : err instanceof Error
            ? err.message
            : t('onboard.error_fallback')
      setFinishError(msg)
    } finally {
      setIsFinishing(false)
    }
  }

  const strengthStyle = STRENGTH_STYLES[strength]

  const wrapStep = (content: ReactNode, actions: ReactNode) =>
    chrome === 'modal' ? (
      <>
        <Modal.Body>{content}</Modal.Body>
        <Modal.Footer className="justify-between">{actions}</Modal.Footer>
      </>
    ) : (
      <div className="flex flex-col gap-6 p-2">
        {content}
        <div className="flex justify-between gap-3">{actions}</div>
      </div>
    )

  // ── Render Step A ────────────────────────────────────────────────────────

  if (step === 'passphrase') {
    const importError = qrImport.status.kind === 'error' ? qrImport.status.message : ''

    return wrapStep(
      <div className={chrome === 'modal' ? 'flex flex-col gap-6' : 'contents'}>
        {/* Header */}
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="bg-accent-soft flex items-center justify-center rounded-full p-3">
            <KeyRound className="text-accent size-6" />
          </div>
          <h2 className="text-fg text-xl font-bold">{t('onboard.title')}</h2>
          <p className="text-fg-muted text-sm leading-relaxed">{t('onboard.body', i18nProvider)}</p>
        </div>

        {/* Textarea — placeholder + aria-label; no visible label (keeps the form scannable). */}
        <div className="flex flex-col gap-1">
          <TextInput
            multiline
            value={phrase}
            onChange={(next) => {
              setPhrase(next)
              setValidateError('')
              qrImport.reset()
            }}
            placeholder={t('onboard.passphrase_placeholder')}
            aria-label={t('onboard.passphrase_label')}
            rows={4}
            className="resize-none"
            disabled={isValidating || isImporting}
            autoFocus
            spellCheck={false}
          />
          {/* Word count feedback */}
          <p
            className={cn(
              'mt-1 pl-2 text-xs',
              wordCount === 24 && unknownWords.length === 0 ? 'text-success' : 'text-fg-muted',
            )}
          >
            {t('onboard.passphrase_word_count', { count: wordCount })}
          </p>
          {unknownWords.length > 0 && (
            <p className="text-warning text-xs">
              {t('onboard.passphrase_unknown_words', { words: unknownWords.join(', ') })}
            </p>
          )}
        </div>

        {/* Second way in: the recovery sheet's QR image. No camera — the user
            points at a file (screenshot, photo, or the sheet's own PNG). */}
        <div className="flex flex-col gap-6 pt-2">
          <div className="flex items-center gap-3" aria-hidden="true">
            <span className="bg-border-subtle h-px flex-1" />
            <span className="text-fg-muted text-xs">{t('onboard.import_qr_divider')}</span>
            <span className="bg-border-subtle h-px flex-1" />
          </div>
          <Button
            variant="secondary"
            className="w-fit self-center"
            onClick={() => {
              void handleImportQr()
            }}
            loading={isImporting}
            disabled={isValidating || isImporting}
            icon={<QrCode className="size-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />}
            data-testid="onboard-import-qr"
          >
            {isImporting ? t('onboard.import_qr_in_progress') : t('onboard.import_qr_button')}
          </Button>
        </div>

        {(validateError || importError) && (
          <Callout tone="danger">{validateError || importError}</Callout>
        )}
      </div>,
      <>
        <Button variant="ghost" onClick={onCancel} disabled={isValidating || isImporting}>
          {t('onboard.back')}
        </Button>
        <Button
          variant="primary"
          loading={isValidating}
          onClick={handleContinue}
          disabled={!passphraseReady || isValidating || isImporting}
        >
          {isValidating ? t('onboard.unlock_in_progress') : t('onboard.continue')}
        </Button>
      </>,
    )
  }

  // ── Render Step B: how this device unlocks ───────────────────────────────

  if (step === 'unlock_method') {
    return wrapStep(
      <div className="flex flex-col gap-6" data-testid="onboard-unlock-method">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="bg-accent-soft flex items-center justify-center rounded-full p-3">
            <KeyRound className="text-accent size-6" strokeWidth={1.75} aria-hidden="true" />
          </div>
          <h2 className="text-fg text-xl font-bold">{t('unlock_method.title')}</h2>
          <p className="text-fg-muted text-sm leading-relaxed">{t('unlock_method.description')}</p>
        </div>

        <UnlockMethodPicker
          value={unlockMethod}
          onChange={setUnlockMethod}
          available={biometricAvailable}
          loading={biometricLoading}
          idPrefix="onboard-unlock-method"
        />
      </div>,
      <>
        <Button variant="ghost" onClick={() => setStep('passphrase')}>
          {t('onboard.back')}
        </Button>
        <Button
          variant="primary"
          disabled={biometricLoading}
          onClick={() => setStep('password')}
          data-testid="onboard-unlock-method-continue"
        >
          {t('onboard.continue')}
        </Button>
      </>,
    )
  }

  // ── Render Step C ────────────────────────────────────────────────────────

  return wrapStep(
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col items-center gap-3 text-center">
        <img
          src="/stickers/sticker-privacy.png"
          alt=""
          aria-hidden="true"
          draggable={false}
          className="block h-24 w-auto shrink-0"
        />
        <h2 className="text-fg text-xl font-bold">{t('onboard.set_password_title')}</h2>
        <p className="text-fg-muted text-sm">{t('onboard.set_password_body')}</p>
      </div>

      {/* Password */}
      <div className="flex flex-col gap-1">
        <label htmlFor="onboard-password" className="text-fg-muted text-xs font-medium">
          {t('set_password.password_label')}
        </label>
        <PasswordInput
          id="onboard-password"
          value={password}
          onChange={(value) => {
            setPassword(value)
            setFinishError('')
          }}
          disabled={isFinishing}
          autoFocus
        />
        {/* Strength bar */}
        {password.length > 0 && (
          <div className="mt-1 flex gap-1">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className={cn(
                  'h-1 flex-1 rounded-full transition-colors duration-(--motion-duration-base)',
                  i < strengthStyle.segments ? strengthStyle.color : 'bg-border-subtle',
                )}
              />
            ))}
          </div>
        )}
      </div>

      {/* Confirm */}
      <div className="flex flex-col gap-1">
        <label htmlFor="onboard-confirm" className="text-fg-muted text-xs font-medium">
          {t('set_password.confirm_label')}
        </label>
        <PasswordInput
          id="onboard-confirm"
          value={confirm}
          onChange={(value) => setConfirm(value)}
          disabled={isFinishing}
        />
        {mismatched && <p className="text-danger-text text-xs">{t('set_password.mismatch')}</p>}
      </div>

      {/* Device name */}
      <div className="flex flex-col gap-1">
        <label htmlFor="onboard-device-name" className="text-fg-muted text-xs font-medium">
          {t('onboard.device_name_label')}
        </label>
        <TextInput
          id="onboard-device-name"
          value={deviceName}
          onChange={setDeviceName}
          placeholder={t('onboard.device_name_placeholder')}
          disabled={isFinishing}
        />
      </div>

      {finishError && <Callout tone="danger">{finishError}</Callout>}
    </div>,
    <>
      <Button variant="ghost" onClick={() => setStep('unlock_method')} disabled={isFinishing}>
        {t('onboard.back')}
      </Button>
      <Button
        variant="primary"
        loading={isFinishing}
        onClick={handleFinish}
        disabled={!canFinish || isFinishing}
      >
        {isFinishing ? t('onboard.unlock_in_progress') : t('onboard.finish')}
      </Button>
    </>,
  )
}
