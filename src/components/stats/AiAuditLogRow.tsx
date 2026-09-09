/**
 * AiAuditLogRow — single-row + expandable-detail render for the audit log table.
 *
 * Pure component (no hooks) so it stays cheap inside a 100+ row table.
 * Click a row to expand the detail strip showing endpoint_host,
 * payload_bytes, latency_ms, error_code, and the raw timestamp.
 */

import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import type { AiAuditLogRow as AuditRow } from '../../types/ai'
import { aiAuditRowKey } from '../../lib/aiAuditKey'
import { cn } from '../../lib/cn'
import { getIntlLocale } from '../../lib/dates'
import { Tooltip } from '../common/Tooltip'

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Return a sub-day-accurate relative-time string for a unix-ms timestamp.
 * Uses Intl.RelativeTimeFormat so it respects the app locale.
 * Falls back to days for older entries.
 */
function formatRelative(ms: number, locale?: string): string {
  const diffSec = Math.floor((Date.now() - ms) / 1000)
  const intlLocale = getIntlLocale(locale)
  const rtf = new Intl.RelativeTimeFormat(intlLocale, { numeric: 'always', style: 'short' })

  if (diffSec < 60) return rtf.format(-diffSec, 'second')
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return rtf.format(-diffMin, 'minute')
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return rtf.format(-diffHr, 'hour')
  const diffDay = Math.floor(diffHr / 24)
  return rtf.format(-diffDay, 'day')
}

/** Truncate a long string with an ellipsis.
 * Strings of exactly `max` characters pass through unchanged.
 * Longer strings are sliced at `max` chars and an ellipsis appended,
 * giving a visible length of max+1. */
function truncate(s: string, max = 20): string {
  if (s.length <= max) return s
  return s.slice(0, max) + '…'
}

/** Chip style by endpoint class. */
function classChip(cls: string): string {
  switch (cls) {
    case 'local':
      return 'bg-success/15 text-success'
    case 'remote':
      return 'bg-warning/15 text-warning'
    case 'subscription':
      return 'bg-accent/15 text-accent'
    case 'on-device':
      return 'bg-info/15 text-info'
    default:
      return 'bg-surface-muted text-fg-secondary'
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  row: AuditRow
  isExpanded: boolean
  /** Stable callback — accepts the composite row key so the parent can hold one reference. */
  onToggle: (key: string) => void
}

function AiAuditLogRowInner({ row, isExpanded, onToggle }: Props) {
  const { t, i18n } = useTranslation('ai')

  const tokensLabel =
    row.tokens_in != null && row.tokens_out != null
      ? t('audit.table.tokens_format', { in: row.tokens_in, out: row.tokens_out })
      : t('audit.table.tokens_none')

  const statusLabel =
    row.status === 'ok' ? (
      <span className="text-success text-xs">✓</span>
    ) : (
      <span className="text-danger-text text-xs">✗ {row.error_code ?? ''}</span>
    )

  return (
    <>
      {/* ── Main row ── */}
      <tr
        className={cn(
          'hover:bg-surface-subtle border-border-default cursor-pointer border-b text-sm transition-colors',
          isExpanded && 'bg-surface-subtle',
        )}
        onClick={() => onToggle(aiAuditRowKey(row))}
        aria-expanded={isExpanded}
      >
        <td className="text-fg-secondary px-3 py-2 font-mono text-xs whitespace-nowrap">
          {formatRelative(row.created_at, i18n.language)}
        </td>
        <td className="overflow-hidden px-3 py-2">
          {/*
           * Wrap the Tooltip in a width-constrained `block` div so the
           * tooltip's own `inline-flex` shell doesn't expand to fit the
           * (un-truncated) feature string and bleed into the operation
           * column. `max-w-full` + `overflow-hidden` on the `<td>` forces
           * the inner `truncate` span to clip at the cell boundary.
           */}
          <Tooltip content={row.feature} placement="top" className="max-w-full">
            <span className="block max-w-full truncate font-medium">{truncate(row.feature)}</span>
          </Tooltip>
        </td>
        <td className="text-fg-secondary px-3 py-2 text-xs whitespace-nowrap">{row.operation}</td>
        <td className="overflow-hidden px-3 py-2">
          {/* Show full provider·model on hover via Tooltip. */}
          <Tooltip
            content={`${row.provider_id} · ${row.model_id}`}
            placement="top"
            className="max-w-full"
          >
            <span className="block max-w-full truncate text-xs">
              {truncate(row.provider_id)} · {truncate(row.model_id)}
            </span>
          </Tooltip>
        </td>
        <td className="px-3 py-2 whitespace-nowrap">
          <span
            className={cn(
              'text-2xs inline-block rounded px-1.5 py-0.5 leading-none font-medium uppercase',
              classChip(row.endpoint_class),
            )}
          >
            {/* I3: localize endpoint_class chip — keys match the filter pills */}
            {t(`audit.filter.class_${row.endpoint_class}`)}
          </span>
        </td>
        <td className="text-fg-secondary px-3 py-2 font-mono text-xs">{tokensLabel}</td>
        <td className="px-3 py-2">{statusLabel}</td>
      </tr>

      {/* ── Expandable detail strip ── */}
      {isExpanded && (
        <tr className="bg-surface-subtle border-border-default border-b">
          <td colSpan={7} className="px-4 py-3">
            <dl className="text-fg-secondary grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
              {/* I4: show full provider_id and model_id for audit purposes */}
              <div>
                <dt className="text-fg-muted font-medium">{t('audit.row_detail.provider')}</dt>
                <dd className="font-mono">{row.provider_id}</dd>
              </div>
              <div>
                <dt className="text-fg-muted font-medium">{t('audit.row_detail.model')}</dt>
                <dd className="font-mono">{row.model_id}</dd>
              </div>
              <div>
                <dt className="text-fg-muted font-medium">{t('audit.row_detail.host')}</dt>
                <dd className="font-mono">{row.endpoint_host || '—'}</dd>
              </div>
              <div>
                <dt className="text-fg-muted font-medium">{t('audit.row_detail.payload')}</dt>
                <dd className="font-mono">{row.payload_bytes.toLocaleString()} B</dd>
              </div>
              <div>
                <dt className="text-fg-muted font-medium">{t('audit.row_detail.latency')}</dt>
                <dd className="font-mono">{row.latency_ms} ms</dd>
              </div>
              {row.error_code && (
                <div>
                  <dt className="text-fg-muted font-medium">{t('audit.row_detail.error_code')}</dt>
                  <dd className="text-danger-text font-mono">{row.error_code}</dd>
                </div>
              )}
              <div>
                <dt className="text-fg-muted font-medium">{t('audit.row_detail.timestamp')}</dt>
                <dd className="font-mono">{new Date(row.created_at).toISOString()}</dd>
              </div>
              <div>
                <dt className="text-fg-muted font-medium">{t('audit.row_detail.device')}</dt>
                <dd className="font-mono">
                  {row.device_name.trim() || truncate(row.device_id, 12)}
                </dd>
              </div>
            </dl>
          </td>
        </tr>
      )}
    </>
  )
}

export const AiAuditLogRowComponent = memo(AiAuditLogRowInner)
