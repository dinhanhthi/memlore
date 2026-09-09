import type { TFunction } from 'i18next'
import type { EmbeddingIndexingStatus } from '../stores/embeddingStatusStore'

/**
 * Shared status-label switch for `EmbeddingIndexingStatus` — used by both
 * `BackfillRow`'s own status line and `AISettingsPanel`'s RAG feature-group
 * hint. Both surfaces read the same `backfill.*` copy, so this is extracted
 * to one place rather than two verbatim switches that could drift
 * (cf-review I4).
 */
export function getEmbeddingStatusLabel(
  status: EmbeddingIndexingStatus,
  pendingCount: number,
  t: TFunction<'ai'>,
  downloadProgress?: number | null,
): string {
  switch (status) {
    case 'indexing':
      return t('backfill.status_indexing', { count: pendingCount })
    case 'waiting':
      return t('backfill.status_waiting')
    case 'stuck':
      return t('backfill.status_stuck')
    case 'paused':
      return t('backfill.status_paused')
    case 'needs_consent':
      return t('backfill.status_needs_consent')
    case 'needs_decision':
      return t('backfill.status_needs_decision')
    case 'error':
      return t('backfill.status_error')
    case 'downloading_model':
      return t('backfill.status_downloading_model', {
        percent: Math.round(downloadProgress ?? 0),
      })
    case 'model_error':
      return t('backfill.status_model_error')
    case 'idle':
    default:
      return t('backfill.status_up_to_date')
  }
}

/**
 * Text colour for a status line, so the state reads at a glance instead of as
 * uniform grey. Pairs with `getEmbeddingStatusLabel` — same switch, same
 * surfaces.
 */
export function getEmbeddingStatusToneClass(status: EmbeddingIndexingStatus): string {
  switch (status) {
    case 'indexing':
    case 'waiting':
    case 'downloading_model':
      // Work in flight — informational, nothing for the user to act on.
      return 'text-info-text'
    case 'paused':
    case 'stuck':
    case 'needs_consent':
    case 'needs_decision':
      // Indexing is stalled until the user does something.
      return 'text-warning-text'
    case 'error':
    case 'model_error':
      return 'text-danger-text'
    case 'idle':
    default:
      return 'text-success-text'
  }
}
