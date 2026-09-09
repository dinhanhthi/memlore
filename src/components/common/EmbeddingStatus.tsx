import { useTranslation } from 'react-i18next'
import { useEmbeddingStatus } from '../../hooks/useEmbeddingStatus'
import { useUpdateActiveTab } from '../../hooks/useActiveTab'
import { useEmbeddingStatusStore } from '../../stores/embeddingStatusStore'
import { useUiStore } from '../../stores/uiStore'
import { Clock, Pause, AlertTriangle, AlertCircle, CircleHelp, type LucideIcon } from 'lucide-react'
import type { EmbeddingIndexingStatus } from '../../stores/embeddingStatusStore'
import { cn } from '../../lib/cn'
import { InlineOrb } from './ThinkingOrb'
import { ShimmerText } from './ShimmerText'
import { Tooltip } from './Tooltip'

const EMBEDDING_ICONS = {
  Clock,
  Pause,
  AlertTriangle,
  AlertCircle,
} satisfies Record<string, LucideIcon>

/**
 * Statuses the compact footer chip stays silent about — the chip only speaks
 * up when the user has something to decide (consent, error, paused) or a
 * download is occupying the machine. "Waiting for edits to settle" read as an
 * alarm about a debounce timer and confused users more than it informed them.
 * Both states stay fully visible in Settings → AI → Embedding (`BackfillRow`).
 */
const FOOTER_HIDDEN_STATUSES: readonly EmbeddingIndexingStatus[] = ['waiting', 'indexing']

/**
 * Mirrors `SyncStatusIcon`: in-flight work shows the searching orb; resting
 * / waiting / error states keep their static lucide icon.
 */
function EmbeddingStatusIcon({
  spin,
  icon: Icon,
  tone,
}: {
  spin: boolean
  icon: LucideIcon | null
  tone: string
}) {
  if (spin) return <InlineOrb state="searching" aria-hidden />
  if (!Icon) return null
  return <Icon className={cn('size-4', tone)} strokeWidth={1.75} />
}

interface EmbeddingStatusProps {
  /**
   * When true, render the compact footer variant — one line, icon + short
   * label. When false, render a wider panel suitable for settings UI.
   */
  compact?: boolean
  className?: string
}

/**
 * Lightweight wrapper that translates `useEmbeddingStatus` into user-facing
 * copy + the right icon — mirrors `SyncStatus`. The component is stateless —
 * all state lives in the hook, which is driven by Tauri backfill events.
 *
 * `idle` (nothing to index / background indexing off) renders nothing.
 * Unlike sync — a persistent connection users like to see confirmed as
 * "up to date" — embedding indexing is opportunistic background work; a
 * permanent "up to date" pill would just be footer noise most of the time.
 */
export function EmbeddingStatus({ compact = false, className }: EmbeddingStatusProps) {
  const { t } = useTranslation(['nav', 'ai'])
  const { status, pendingCount, lastError, downloadProgress, modelError } = useEmbeddingStatus()
  const updateActiveTab = useUpdateActiveTab()
  const setEmbeddingExplainerOpen = useUiStore((s) => s.setEmbeddingExplainerOpen)
  const setDecisionModalOpen = useEmbeddingStatusStore((s) => s.setDecisionModalOpen)

  if (status === 'idle') return null
  if (compact && FOOTER_HIDDEN_STATUSES.includes(status)) return null

  let iconName: keyof typeof EMBEDDING_ICONS | null = null
  let label: string
  let tooltip: string
  let tone = 'text-fg-secondary'
  let spin = false

  switch (status) {
    case 'indexing':
      spin = true
      label = t('embedding_status.indexing', { count: pendingCount })
      tooltip = t('embedding_status.tooltip_indexing', { count: pendingCount })
      break
    case 'waiting':
      iconName = 'Clock'
      tone = 'text-fg-muted'
      label = t('embedding_status.waiting')
      tooltip = t('embedding_status.tooltip_waiting')
      break
    case 'paused':
      iconName = 'Pause'
      tone = 'text-fg-muted'
      label = t('embedding_status.paused')
      tooltip = t('embedding_status.tooltip_paused')
      break
    case 'needs_consent':
      iconName = 'AlertTriangle'
      tone = 'text-warning'
      label = t('embedding_status.needs_consent')
      tooltip = t('embedding_status.tooltip_needs_consent')
      break
    case 'needs_decision':
      iconName = 'AlertTriangle'
      tone = 'text-warning'
      label = t('embedding_status.needs_decision')
      tooltip = t('embedding_status.tooltip_needs_decision')
      break
    case 'error':
      iconName = 'AlertCircle'
      tone = 'text-danger-text'
      label = t('embedding_status.error')
      tooltip = lastError ?? t('embedding_status.tooltip_error')
      break
    case 'downloading_model':
      spin = true
      label = t('footer.ai_downloading', {
        percent: `${Math.round(downloadProgress ?? 0)}%`,
      })
      tooltip = t('embedding_status.tooltip_downloading_model')
      break
    case 'model_error':
      iconName = 'AlertCircle'
      tone = 'text-danger-text'
      label = t('embedding_status.model_error')
      tooltip = modelError ?? t('embedding_status.tooltip_model_error')
      break
    case 'stuck':
      iconName = 'AlertTriangle'
      tone = 'text-warning'
      label = t('ai:backfill.status_stuck')
      tooltip = t('ai:backfill.status_stuck')
      break
    // `idle` is handled above via early return. Any other future status
    // falls through to hidden rather than a broken row.
    default:
      return null
  }

  const StatusIcon = iconName ? EMBEDDING_ICONS[iconName] : null

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    // Decision modal re-entry: open the embed-sync modal instead of only
    // dumping the user in Settings when a multi-device decision is pending.
    if (status === 'needs_decision') {
      setDecisionModalOpen(true)
      return
    }
    // Routes to the AI Settings category (Embedding tab lives there via
    // `BackfillRow`); no deep-link mechanism into a specific tab exists yet,
    // so this lands on the category root rather than the Embedding tab itself.
    updateActiveTab({ activeView: 'settings', selectedEntryId: null, settingsCategory: 'ai' })
  }

  // Opens the general "How AI works" overview. Separate from `handleClick`
  // so routing to AI Settings and learning more never fight over one click.
  // Embedding-control detail lives inline in Settings → AI (`BackfillRow`).
  const handleLearnMore = (e: React.MouseEvent) => {
    e.stopPropagation()
    setEmbeddingExplainerOpen(true)
  }

  if (compact) {
    // No "learn more" on the footer chip: the general AI overview is broader
    // than "what is this status?" — open AI Settings instead; the "?" on the
    // AI Settings title covers the overview.
    return (
      // Raw <button> for icon-only footer controls — matches the
      // established precedent in `SyncStatus.tsx`'s compact variant.
      <button
        type="button"
        onClick={handleClick}
        aria-label={
          status === 'needs_decision'
            ? t('embedding_status.view_decision')
            : t('embedding_status.view_settings')
        }
        data-testid="embedding-status"
        data-state={status}
        className={cn(
          'text-fg-muted hover:bg-surface-subtle hover:text-fg flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border-none bg-transparent px-2 transition-colors duration-150',
          className,
        )}
      >
        <span className="flex shrink-0">
          <EmbeddingStatusIcon spin={spin} icon={StatusIcon} tone={tone} />
        </span>
        <Tooltip content={tooltip} placement="top">
          <ShimmerText active={spin} className={cn('text-xs font-medium', !spin && tone)}>
            {label}
          </ShimmerText>
        </Tooltip>
      </button>
    )
  }

  return (
    <div
      className={cn(
        'border-border-default bg-elevated flex items-center gap-3 rounded-2xl border px-3 py-2',
        className,
      )}
      data-testid="embedding-status"
      data-state={status}
    >
      <span className="flex shrink-0">
        <EmbeddingStatusIcon spin={spin} icon={StatusIcon} tone={tone} />
      </span>
      <Tooltip content={tooltip} placement="top">
        <ShimmerText active={spin} className={cn('text-sm font-medium', !spin && tone)}>
          {label}
        </ShimmerText>
      </Tooltip>
      <Tooltip content={t('embedding_status.learn_more')} placement="top">
        <button
          type="button"
          onClick={handleLearnMore}
          aria-label={t('embedding_status.learn_more_aria')}
          data-testid="embedding-status-learn-more"
          className="text-fg-muted hover:bg-surface-subtle hover:text-fg ml-auto flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md border-none bg-transparent transition-colors duration-150"
        >
          <CircleHelp className="size-3.5" strokeWidth={1.75} />
        </button>
      </Tooltip>
    </div>
  )
}
