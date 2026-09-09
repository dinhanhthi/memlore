import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldAlert } from 'lucide-react'
import { AuthPageCard } from '../common/AuthPageCard'
import { Button } from '../common/Button'
import { ForgotPasswordScreen } from './ForgotPasswordScreen'

interface Props {
  /** Called after successful phrase recovery so App leaves this screen. */
  onRecovered: () => void
}

/**
 * Shown when `startup_init` returns `BootFileCorrupt`: the boot sidecar is
 * invalid/unreadable but the encrypted vault on disk was NOT wiped.
 *
 * Explains that data is safe and the 24-word recovery phrase is the path
 * forward, then reuses `ForgotPasswordScreen` / `recover_with_passphrase`
 * (no new rekey flow).
 */
export function BootFileCorruptScreen({ onRecovered }: Props) {
  const { t } = useTranslation('auth')
  const [showRecovery, setShowRecovery] = useState(false)

  if (showRecovery) {
    return (
      <ForgotPasswordScreen
        onCancel={() => setShowRecovery(false)}
        onSuccess={onRecovered}
        cancelLabel={t('boot_file_corrupt.back')}
      />
    )
  }

  return (
    <AuthPageCard data-testid="boot-file-corrupt-card" className="max-w-120 p-8">
      <div className="mb-6 flex flex-col items-center gap-3 text-center">
        <div className="bg-accent/10 flex items-center justify-center rounded-full p-3">
          <ShieldAlert className="text-accent size-6" strokeWidth={1.75} />
        </div>
        <h1 className="font-title text-fg text-2xl font-extrabold">
          {t('boot_file_corrupt.title')}
        </h1>
        <p className="text-fg-secondary text-sm leading-relaxed">{t('boot_file_corrupt.body')}</p>
        <p className="text-fg-muted text-sm leading-relaxed">{t('boot_file_corrupt.safe_note')}</p>
      </div>

      <div className="flex flex-col gap-3">
        <Button
          type="button"
          variant="primary"
          onClick={() => setShowRecovery(true)}
          className="w-full"
        >
          {t('boot_file_corrupt.cta')}
        </Button>
        <p className="text-fg-muted text-center text-xs leading-relaxed">
          {t('boot_file_corrupt.hint')}
        </p>
      </div>
    </AuthPageCard>
  )
}
