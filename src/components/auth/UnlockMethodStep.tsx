import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Lock } from 'lucide-react'
import { Button } from '../common/Button'
import { AuthPageCard } from '../common/AuthPageCard'
import { UnlockMethodPicker, type PickableMethod } from './UnlockMethodPicker'
import { useBiometricAvailability } from '../../hooks/useBiometricAvailability'

interface Props {
  /** Called with the picked method when the user continues. */
  onSelected: (method: PickableMethod) => void
  /** Back out of the wizard entirely (this is now its first screen). */
  onCancel: () => void
}

/**
 * `UnlockMethodStep` — step 0 of first-time setup: how this device unlocks the
 * vault day to day.
 *
 * The pills and the explanatory copy live in `UnlockMethodPicker`, shared with
 * the join flow (`OnboardNewDeviceScreen`), which cannot use this screen
 * directly because it renders inside a card/modal supplied by its parent.
 *
 * The password screen always follows — every device gets a password.
 */
export function UnlockMethodStep({ onSelected, onCancel }: Props) {
  const { t } = useTranslation('auth')
  const { available, loading } = useBiometricAvailability()
  const [method, setMethod] = useState<PickableMethod>('password')

  return (
    <AuthPageCard data-testid="unlock-method-step" className="max-w-120 p-8">
      <div className="mb-6 flex flex-col items-center gap-3 text-center">
        <div className="bg-accent-soft flex items-center justify-center rounded-full p-3">
          <Lock className="text-accent size-6" strokeWidth={1.75} aria-hidden="true" />
        </div>
        <h1 className="font-title text-fg text-3xl font-extrabold">{t('unlock_method.title')}</h1>
        <p className="text-fg-muted text-sm">{t('unlock_method.description')}</p>
      </div>

      <UnlockMethodPicker
        value={method}
        onChange={setMethod}
        available={available}
        loading={loading}
      />

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-between">
        <Button variant="ghost" size="md" onClick={onCancel}>
          {t('unlock_method.back')}
        </Button>
        <Button
          variant="primary"
          size="md"
          disabled={loading}
          data-testid="unlock-method-continue"
          onClick={() => onSelected(method)}
        >
          {t('unlock_method.continue')}
        </Button>
      </div>
    </AuthPageCard>
  )
}
