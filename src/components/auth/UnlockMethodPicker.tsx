import { useTranslation } from 'react-i18next'
import { Fingerprint, KeyRound } from 'lucide-react'
import { RadioOptionPillGroup } from '../common/RadioOptionPill'
import type { UnlockMethod } from '../../lib/tauri'

/**
 * The two values this picker can produce. `both` is what "unlock with Touch ID"
 * really means: the OS keystore key wraps the master AND the password wrap is
 * still written, so cancelling the biometric prompt falls back to typing the
 * password. The backend treats a bare `os_kek` identically, but sending `both`
 * keeps the stored label honest. There is no password-less option by design —
 * a device with neither a password nor a working os_kek is a bricked vault.
 */
export type PickableMethod = Extract<UnlockMethod, 'password' | 'both'>

interface Props {
  value: PickableMethod
  onChange: (method: PickableMethod) => void
  /** Result of the `is_biometric_available()` probe. */
  available: boolean
  /** True while the probe is still in flight. */
  loading: boolean
  /** Prefix for the generated radio ids — must be unique per rendered picker. */
  idPrefix?: string
}

/**
 * `UnlockMethodPicker` — the pills + explanatory note for "how does this device
 * unlock the vault", with no card, heading or navigation buttons of its own.
 *
 * Presentational on purpose: it is used both by `UnlockMethodStep` (first-run,
 * inside its own `AuthPageCard`) and by the join flow's step in
 * `OnboardNewDeviceScreen`, which already renders inside an `AuthPageCard` or a
 * `Modal.Body`. The availability probe stays with the caller so the caller can
 * also gate its own Continue button on it.
 *
 * The OS-unlock option appears only when the probe answered true. While the
 * probe is in flight neither the option nor the "not available here" note
 * renders (the note would flash on macOS before the probe resolves); a failed
 * probe settles as unavailable, so the UI degrades to password-only rather
 * than blocking the flow.
 */
export function UnlockMethodPicker({
  value,
  onChange,
  available,
  loading,
  idPrefix = 'unlock-method',
}: Props) {
  const { t } = useTranslation('auth')

  const options = [
    {
      value: 'password' as const,
      label: (
        <span className="flex items-center gap-1.5">
          <KeyRound className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
          {t('unlock_method.option_password')}
        </span>
      ),
      testId: 'unlock-method-password',
    },
    ...(available
      ? [
          {
            value: 'both' as const,
            label: (
              <span className="flex items-center gap-1.5">
                <Fingerprint className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
                {t('unlock_method.option_os')}
              </span>
            ),
            testId: 'unlock-method-os',
          },
        ]
      : []),
  ]

  return (
    <div className="flex flex-col items-center gap-3">
      {loading ? (
        <p className="text-fg-muted text-sm" aria-live="polite">
          {t('unlock_method.checking')}
        </p>
      ) : (
        <RadioOptionPillGroup
          value={value}
          onChange={onChange}
          options={options}
          ariaLabel={t('unlock_method.group_label')}
          idPrefix={idPrefix}
        />
      )}

      <p
        className="text-fg-muted text-center text-sm leading-relaxed"
        data-testid="unlock-method-note"
      >
        {value === 'both' ? t('unlock_method.os_note') : t('unlock_method.password_note')}
      </p>

      {!loading && !available && (
        <p className="text-fg-muted text-center text-xs leading-relaxed">
          {t('unlock_method.unavailable_note')}
        </p>
      )}
    </div>
  )
}
