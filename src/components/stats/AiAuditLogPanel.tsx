/**
 * AiAuditLogPanel — "AI audit log" tab inside Statistics (Phase 6 Stretch S2-2).
 *
 * Layout:
 *  - Retention presets + Clear log button — same row, pinned at top
 *  - Filter bar: feature multi-select + provider multi-select + class chips + date-range pills
 *  - Scrollable table (25 rows per page, "Load more" sentinel) — flex-1 min-h-0
 *  - Privacy note — pinned footer
 *  - Clear-log confirm modal
 *
 * No content fields are displayed — the log contains metadata only.
 *
 * Component tests are NOT written per CLAUDE.md — UI changes too fast.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ShieldCheck } from 'lucide-react'
import { useAiAuditLog } from '../../hooks/useAiAuditLog'
import { aiAuditRowKey } from '../../lib/aiAuditKey'
import {
  AI_AUDIT_RETENTION_OPTIONS,
  type AiAuditRetentionOption,
  toAiAuditRetentionOption,
} from '../../lib/aiAuditRetention'
import type { AiAuditLogFilter, EndpointClass } from '../../types/ai'
import { Button } from '../common/Button'
import { Callout } from '../common/Callout'
import { Modal } from '../common/Modal'
import { SegmentedControl } from '../common/SegmentedControl'
import { RestoredScroll } from '../common/RestoredScroll'
import { AiAuditLogRowComponent } from './AiAuditLogRow'

// ─── Date-range presets ───────────────────────────────────────────────────────

type RangeKey = '24h' | '7d' | '30d' | 'all'

function sinceForRange(key: RangeKey): number | undefined {
  const now = Date.now()
  switch (key) {
    case '24h':
      return now - 24 * 60 * 60 * 1000
    case '7d':
      return now - 7 * 24 * 60 * 60 * 1000
    case '30d':
      return now - 30 * 24 * 60 * 60 * 1000
    default:
      return undefined
  }
}

// ─── MultiChipSelect — small inline multi-select (chips + dropdown) ──────────

/** Minimal multi-select: a "pill" button that opens a small dropdown
 *  listing all unique values seen in the current rows.
 *  NOTE: options derive from loaded rows — load more rows to see more options. */
function MultiChipSelect({
  label,
  placeholder,
  options,
  selected,
  onChange,
  emptyHint,
}: {
  label: string
  placeholder: string
  options: string[]
  selected: string[]
  onChange: (values: string[]) => void
  /** Message to show when the options list is empty (e.g. no rows loaded yet). */
  emptyHint?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside mousedown — works correctly in WKWebView (macOS/Tauri)
  // where relatedTarget is null by default, making onBlur-based detection unreliable.
  useEffect(() => {
    if (!open) return
    const handle = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])

  const toggle = (val: string) => {
    onChange(selected.includes(val) ? selected.filter((s) => s !== val) : [...selected, val])
  }

  const hasActive = selected.length > 0

  return (
    <div className="relative" ref={ref}>
      <Button
        variant="secondary"
        size="sm"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((p) => !p)}
        className={hasActive ? 'text-accent-text' : 'text-fg-secondary'}
      >
        {hasActive ? `${label} (${selected.length})` : placeholder}
        <ChevronDown className="size-3.5 opacity-60" aria-hidden="true" />
      </Button>

      {open && (
        <div className="bg-elevated border-border-default absolute top-full left-0 z-30 mt-1 max-h-48 min-w-40 overflow-y-auto rounded-xl border py-1 shadow-(--elev-4)">
          {options.length === 0 ? (
            <p className="text-fg-muted px-3 py-2 text-xs">{emptyHint ?? '—'}</p>
          ) : (
            <ul role="listbox" aria-multiselectable="true" aria-label={label}>
              {options.map((opt) => (
                <li key={opt} role="option" aria-selected={selected.includes(opt)}>
                  <button
                    type="button"
                    onClick={() => toggle(opt)}
                    className={`hover:bg-surface-row-hover flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                      selected.includes(opt) ? 'text-accent font-medium' : 'text-fg'
                    }`}
                  >
                    <span
                      className={`size-3 shrink-0 rounded border ${selected.includes(opt) ? 'border-accent bg-accent' : 'border-border-default'}`}
                      aria-hidden="true"
                    />
                    {opt}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export function AiAuditLogPanel() {
  const { t } = useTranslation('ai')

  const {
    rows,
    isLoading,
    error,
    filter,
    setFilter,
    loadMore,
    hasMore,
    clearAll,
    retention,
    isRetentionLoading,
    setRetention,
  } = useAiAuditLog()

  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [rangeKey, setRangeKey] = useState<RangeKey>('all')
  const [retentionSaving, setRetentionSaving] = useState(false)
  const [retentionError, setRetentionError] = useState<string | null>(null)

  // ── Derive unique options from all loaded rows ─────────────────────────────
  // NOTE: options come from currently-loaded rows — load more to see more options.

  // Options accumulate across loads: deriving them from the *filtered* rows
  // alone made every other option vanish as soon as one was picked. Selected
  // values are always kept so a chip can be un-ticked even with zero rows.
  const seenFeatures = useRef(new Set<string>())
  const seenProviders = useRef(new Set<string>())
  const featureOptions = useMemo(() => {
    for (const r of rows) seenFeatures.current.add(r.feature)
    for (const f of filter.features ?? []) seenFeatures.current.add(f)
    return [...seenFeatures.current].sort()
  }, [rows, filter.features])
  const providerOptions = useMemo(() => {
    for (const r of rows) seenProviders.current.add(r.provider_id)
    for (const p of filter.providers ?? []) seenProviders.current.add(p)
    return [...seenProviders.current].sort()
  }, [rows, filter.providers])

  // ── Filter actions ─────────────────────────────────────────────────────────

  const updateFilter = useCallback(
    (patch: Partial<AiAuditLogFilter>) => {
      // I6: shallow-compare before calling setFilter to avoid redundant refetches
      // when clicking the same chip twice.
      const next = { ...filter, ...patch }
      const unchanged = (Object.keys(patch) as Array<keyof AiAuditLogFilter>).every((k) => {
        const a = filter[k]
        const b = next[k]
        if (Array.isArray(a) && Array.isArray(b)) {
          return JSON.stringify(a) === JSON.stringify(b)
        }
        return a === b
      })
      if (unchanged) return
      setFilter(next)
    },
    [filter, setFilter],
  )

  const handleFeaturesChange = useCallback(
    (values: string[]) => {
      updateFilter({ features: values.length > 0 ? values : undefined })
    },
    [updateFilter],
  )

  const handleProvidersChange = useCallback(
    (values: string[]) => {
      updateFilter({ providers: values.length > 0 ? values : undefined })
    },
    [updateFilter],
  )

  const handleClassChange = useCallback(
    (cls: EndpointClass | 'all') => {
      updateFilter({ classifications: cls === 'all' ? undefined : [cls] })
    },
    [updateFilter],
  )

  const handleRangeChange = useCallback(
    (key: RangeKey) => {
      setRangeKey(key)
      const since = sinceForRange(key)
      updateFilter({ since })
    },
    [updateFilter],
  )

  // ── Retention presets ──────────────────────────────────────────────────────

  const handleRetentionChange = useCallback(
    async (value: AiAuditRetentionOption) => {
      setRetentionSaving(true)
      setRetentionError(null)
      try {
        await setRetention(Number(value))
      } catch (e) {
        setRetentionError(e instanceof Error ? e.message : String(e))
      } finally {
        setRetentionSaving(false)
      }
    },
    [setRetention],
  )

  // ── Clear log ──────────────────────────────────────────────────────────────

  const handleClearConfirm = useCallback(async () => {
    setClearing(true)
    try {
      await clearAll()
    } finally {
      setClearing(false)
      setShowClearConfirm(false)
    }
  }, [clearAll])

  // S8: Stable onToggle callback — one reference shared by every row so
  // React.memo on AiAuditLogRowComponent actually prevents unnecessary re-renders.
  const handleRowToggle = useCallback((key: string) => {
    setExpandedKey((prev) => (prev === key ? null : key))
  }, [])

  // ── Active classification chip value ──────────────────────────────────────
  const activeClass = filter.classifications?.length === 1 ? filter.classifications[0] : 'all'

  // S10: detect whether any filter is active so we can pick the right empty-state copy.
  const isFilterActive =
    (filter.features && filter.features.length > 0) ||
    (filter.providers && filter.providers.length > 0) ||
    (filter.classifications && filter.classifications.length > 0) ||
    filter.since != null

  const rangeOptions: RangeKey[] = ['24h', '7d', '30d', 'all']
  const classOptions: Array<EndpointClass | 'all'> = [
    'all',
    'local',
    'remote',
    'subscription',
    'on-device',
  ]

  return (
    <div className="flex h-full flex-col gap-5">
      {/* ── Retention presets + Clear log button (same row, pinned at top) ── */}
      <div className="flex shrink-0 flex-wrap items-center gap-4">
        <div className="flex min-w-70 flex-1 items-center gap-3">
          <span className="text-fg shrink-0 text-sm font-medium">{t('audit.retention.label')}</span>
          <SegmentedControl<AiAuditRetentionOption>
            ariaLabel={t('audit.retention.label')}
            idPrefix="audit-retention"
            value={toAiAuditRetentionOption(retention)}
            onChange={(value) => void handleRetentionChange(value)}
            commitOnArrow={false}
            options={AI_AUDIT_RETENTION_OPTIONS.map((value) => ({
              value,
              label: t(`audit.retention.option_${value}`),
              ariaLabel: t(`audit.retention.option_${value}_aria`),
              disabled: isRetentionLoading || retentionSaving,
            }))}
          />
        </div>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => setShowClearConfirm(true)}
          disabled={rows.length === 0 && !isLoading}
        >
          {t('audit.clear.button')}
        </Button>
      </div>

      {retentionError && (
        <p role="alert" className="text-danger-text shrink-0 text-sm">
          {t('audit.retention.save_error', { error: retentionError })}
        </p>
      )}

      {/* ── Filter bar ────────────────────────────────────────────────────── */}
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {/* Feature multi-select */}
        <MultiChipSelect
          label={t('audit.filter.feature_label')}
          placeholder={t('audit.filter.feature_placeholder')}
          options={featureOptions}
          selected={filter.features ?? []}
          onChange={handleFeaturesChange}
          emptyHint={t('audit.filter.options_empty_hint')}
        />

        {/* Provider multi-select */}
        <MultiChipSelect
          label={t('audit.filter.provider_label')}
          placeholder={t('audit.filter.provider_placeholder')}
          options={providerOptions}
          selected={filter.providers ?? []}
          onChange={handleProvidersChange}
          emptyHint={t('audit.filter.options_empty_hint')}
        />

        {/* Endpoint class */}
        <SegmentedControl<EndpointClass | 'all'>
          ariaLabel={t('audit.filter.class_label')}
          value={activeClass}
          onChange={handleClassChange}
          options={classOptions.map((cls) => ({
            value: cls,
            label: t(`audit.filter.class_${cls}`),
          }))}
        />

        {/* Date range */}
        <SegmentedControl<RangeKey>
          ariaLabel={t('audit.filter.range_label')}
          value={rangeKey}
          onChange={handleRangeChange}
          options={rangeOptions.map((key) => ({
            value: key,
            label: t(`audit.filter.range_${key}`),
          }))}
        />
      </div>

      {/* ── Error banner ─────────────────────────────────────────────────── */}
      {error && (
        <Callout tone="danger" className="shrink-0">
          {error}
        </Callout>
      )}

      {/* ── Table ───────────────────────────────────────────────────────────
       *
       * `flex-1 min-h-0` lets the table claim the remaining height inside the
       * flex-column root, and `overflow-auto` keeps scrolling local to
       * the table so the retention, clear, and filter controls stay pinned
       * above it while the privacy note stays pinned in the footer. */}
      <RestoredScroll
        view="stats"
        sub="audit-table"
        ready={!isLoading || rows.length > 0}
        data-testid="ai-audit-table-scroll"
        className="border-border-default flex min-h-0 flex-1 flex-col overflow-auto rounded-lg border"
      >
        {rows.length === 0 && !isLoading ? (
          // S10: pick copy based on whether a filter is active
          <p className="text-fg-muted py-12 text-center text-sm">
            {isFilterActive ? t('audit.empty_filtered') : t('audit.empty')}
          </p>
        ) : (
          <div>
            {/*
             * `table-fixed` (instead of default `table-auto`) makes the
             * column widths honour the `<th>` `w-*` classes below. Without
             * it, the provider/model cell's long text would bleed into the
             * neighbouring class chip even though the inner `<span>` has
             * `truncate`.
             */}
            <table className="w-full table-fixed text-left text-sm">
              <colgroup>
                <col className="w-20" />
                <col className="w-30" />
                <col className="w-20" />
                <col className="w-45" />
                <col className="w-22.5" />
                <col className="w-27.5" />
                <col className="w-17.5" />
              </colgroup>
              <thead data-testid="ai-audit-table-header" className="bg-panel-2 sticky top-0 z-10">
                <tr className="border-border-default border-b">
                  <th className="bg-panel-2 text-fg-muted px-3 py-2 text-xs font-medium">
                    {t('audit.table.col_time')}
                  </th>
                  <th className="bg-panel-2 text-fg-muted px-3 py-2 text-xs font-medium">
                    {t('audit.table.col_feature')}
                  </th>
                  <th className="bg-panel-2 text-fg-muted px-3 py-2 text-xs font-medium">
                    {t('audit.table.col_operation')}
                  </th>
                  <th className="bg-panel-2 text-fg-muted px-3 py-2 text-xs font-medium">
                    {t('audit.table.col_provider')}
                  </th>
                  <th className="bg-panel-2 text-fg-muted px-3 py-2 text-xs font-medium">
                    {t('audit.table.col_class')}
                  </th>
                  <th className="bg-panel-2 text-fg-muted px-3 py-2 text-xs font-medium">
                    {t('audit.table.col_tokens')}
                  </th>
                  <th className="bg-panel-2 text-fg-muted px-3 py-2 text-xs font-medium">
                    {t('audit.table.col_status')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const key = aiAuditRowKey(row)
                  return (
                    <AiAuditLogRowComponent
                      key={key}
                      row={row}
                      isExpanded={expandedKey === key}
                      onToggle={handleRowToggle}
                    />
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Load more */}
        {(isLoading || hasMore) && rows.length > 0 && (
          <div className="border-border-default border-t px-4 py-3 text-center">
            <Button variant="ghost" size="sm" onClick={loadMore} disabled={isLoading}>
              {isLoading ? t('audit.loading') : t('audit.load_more')}
            </Button>
          </div>
        )}

        {isLoading && rows.length === 0 && (
          <p className="text-fg-muted py-8 text-center text-sm">{t('audit.loading')}</p>
        )}
      </RestoredScroll>

      {/* ── Privacy footer ───────────────────────────────────────────────── */}
      <div
        data-testid="ai-audit-privacy-footer"
        className="border-border-default text-fg-muted hover:text-fg -mr-5 -mb-5 -ml-5 flex shrink-0 items-start gap-2 border-t px-2 py-2 text-xs transition-colors"
      >
        <ShieldCheck
          className="text-success-text mt-0.5 size-3.5 shrink-0"
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <p className="leading-snug">
          <span className="font-medium">{t('audit.privacy_note_label')}</span>{' '}
          {t('audit.privacy_note_desc')}
        </p>
      </div>

      {/* ── Clear confirm modal ────────────────────────────────────────────── */}
      {/* I9: Cancel button is first in DOM order so Modal's auto-focus selects
          it, preventing accidental Enter-key confirmation of a destructive action. */}
      {showClearConfirm && (
        <Modal onClose={() => setShowClearConfirm(false)}>
          <Modal.Header description={t('audit.clear.confirm_body')}>
            {t('audit.clear.confirm_title')}
          </Modal.Header>
          <Modal.Footer>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowClearConfirm(false)}
              disabled={clearing}
            >
              {t('audit.clear.cancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleClearConfirm}
              disabled={clearing}
            >
              {t('audit.clear.confirm_action')}
            </Button>
          </Modal.Footer>
        </Modal>
      )}
    </div>
  )
}
