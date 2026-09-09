import { Map } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useBasemap } from '../../hooks/useBasemap'
import { cn } from '../../lib/cn'
import { Button } from './Button'
import { ShimmerText } from './ShimmerText'
import { Tooltip } from './Tooltip'

interface BasemapStatusProps {
  /**
   * When true, render the compact footer variant — one chip, icon +
   * short percent label. Mirrors `EmbeddingStatus` / `OnDeviceLlmStatus`.
   */
  compact?: boolean
  className?: string
}

/**
 * Footer chip for the offline world-basemap download.
 *
 * Visible only while `status === 'downloading'` — idle / not_downloaded
 * / ready render `null` so the footer stays uncluttered after the
 * one-time fetch. The download is fire-and-forget; this chip is how
 * the user sees it continue after leaving Settings.
 */
export function BasemapStatus({ compact = false, className }: BasemapStatusProps) {
  const { t } = useTranslation('settings')
  const { status, percent, cancel } = useBasemap()

  if (status !== 'downloading') return null

  const rounded = Math.round(percent)
  const label = t('basemap.status.downloading', { percent: rounded })
  const tooltip = t('basemap.status.tooltip')
  const cancelLabel = t('basemap.status.cancel')

  if (compact) {
    return (
      <div
        className={cn('flex shrink-0 items-center gap-1', className)}
        data-testid="basemap-status"
        data-state={status}
      >
        <Tooltip content={tooltip} placement="top" multiline>
          <div
            role="img"
            aria-label={label}
            className="text-fg-muted flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2"
          >
            <Map className="text-accent size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
            <ShimmerText active className="text-xs font-medium">
              {label}
            </ShimmerText>
          </div>
        </Tooltip>
        <Button variant="ghost" size="xs" onClick={() => void cancel()}>
          {cancelLabel}
        </Button>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'border-border-default bg-elevated flex items-center gap-3 rounded-2xl border px-3 py-2',
        className,
      )}
      data-testid="basemap-status"
      data-state={status}
    >
      <Map className="text-accent size-4 shrink-0" strokeWidth={1.75} aria-hidden />
      <Tooltip content={tooltip} placement="top" multiline>
        <ShimmerText active className="text-fg-secondary min-w-0 flex-1 text-sm font-medium">
          {label}
        </ShimmerText>
      </Tooltip>
      <Button variant="secondary" size="xs" onClick={() => void cancel()}>
        {cancelLabel}
      </Button>
    </div>
  )
}
