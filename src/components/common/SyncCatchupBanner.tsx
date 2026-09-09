import { CloudDownload } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSyncCatchup } from '../../hooks/useSyncCatchup'
import { useSync } from '../../hooks/useSync'
import { cn } from '../../lib/cn'

/**
 * Explains that whole-vault views are temporarily based on a partial local
 * vault while a newly connected device catches up with its peers.
 */
export function SyncCatchupBanner({ className }: { className?: string }) {
  const { t } = useTranslation('common')
  const { status } = useSync()
  const catchup = useSyncCatchup()

  if (!status?.configured || catchup.complete) return null

  const message = t('sync_catchup.incomplete', {
    defaultValue: 'Figures are still filling in while older entries sync.',
  })
  const progress = t('sync_catchup.progress', {
    defaultValue: '{{pulled}} / {{total}} entries synced',
    pulled: catchup.pulled,
    total: catchup.total,
  })

  return (
    <div
      className={cn(
        'border-border-default text-fg-muted hover:text-fg flex items-start gap-2 border-t px-2 py-2 text-xs transition-colors',
        className,
      )}
      role="status"
    >
      <span className="text-success-text mt-0.5 shrink-0" aria-hidden="true">
        <CloudDownload className="size-3.5" strokeWidth={1.75} />
      </span>
      <p className="min-w-0 leading-snug">
        <span className="font-medium">{message}</span> <span>{progress}</span>
      </p>
    </div>
  )
}
