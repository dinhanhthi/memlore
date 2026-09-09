import { RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useStaleForceRePairRecheck } from '../../hooks/useStaleForceRePairRecheck'
import { AuthPageCard } from '../common/AuthPageCard'
import { DriveReconnectForm } from './DriveReconnectForm'

interface Props {
  onCompleted: () => void
}

/**
 * Shown when the backend could not VERIFY the cloud keyring (reason
 * `keyring_check_inconclusive`, or an unknown reason) — as opposed to detecting
 * a real peer rotation.
 *
 * Reconnecting Drive is the only action needed here, so this screen
 * deliberately has no recovery phrase field: the flag came from a failed check
 * (dead token, network blip, or a cloud keyring that no longer exists), none of
 * which the 24 words can fix. Offering them would be worse than useless — when
 * the cloud keyring is gone the mnemonic path fails with "vault may be
 * corrupted", which reads like data loss and is how users conclude their
 * journal is gone.
 *
 * Nothing is lost by omitting the field: if the reconnect turns up a genuine
 * rotation, `DriveReconnectForm` pushes `vault_rotated` into the store and
 * `App` re-routes to `ForceRePairScreen`, which does ask for the phrase.
 */
export function ReconnectDriveScreen({ onCompleted }: Props) {
  const { t } = useTranslation('auth')

  useStaleForceRePairRecheck(onCompleted)

  return (
    <AuthPageCard className="max-w-110 p-8">
      <div className="mb-6 flex flex-col items-center gap-3 text-center">
        <div className="bg-accent/10 flex items-center justify-center rounded-full p-3">
          <RefreshCw className="text-accent size-6" strokeWidth={1.75} />
        </div>
        <h1 className="font-title text-fg text-2xl font-extrabold">{t('reconnect_drive.title')}</h1>
        <p className="text-fg-muted text-sm leading-relaxed">{t('reconnect_drive.body')}</p>
      </div>

      <DriveReconnectForm
        onResolved={onCompleted}
        stillRequiredMessage={t('reconnect_drive.still_required')}
      />
    </AuthPageCard>
  )
}
