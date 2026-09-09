/**
 * AiUsagePanel — "AI usage" tab inside Statistics (Phase 6 Stretch S3).
 *
 * Layout:
 *  - Privacy note (no cost / no pricing) — pinned at the top
 *  - Period selector pills (24h / 7d / 30d / 90d / All time)
 *  - Headline cards (calls / tokens in / tokens out / bytes sent)
 *  - Per-provider list
 *  - Daily tokens-out bar chart (lazy-imported recharts)
 *  - Breakdown table (sortable by column)
 *
 * NO cost / pricing / $ / currency information is shown anywhere.
 * Component tests are NOT written per CLAUDE.md.
 */

import { useTranslation } from 'react-i18next'
import { Info } from 'lucide-react'
import { useAiUsage } from '../../hooks/useAiUsage'
import type { UsagePeriod } from '../../types/ai'
import { RadioOptionPill } from '../common/RadioOptionPill'
import { AiUsageHeadlineCards } from './AiUsageHeadlineCards'
import { AiUsageBreakdownTable } from './AiUsageBreakdownTable'
import { AiUsageDailyChart } from './AiUsageDailyChart'
import { AiUsageSectionHeading } from './AiUsageSectionHeading'

const PERIODS: UsagePeriod[] = ['24h', '7d', '30d', '90d', 'all']

export function AiUsagePanel() {
  const { t } = useTranslation('ai')
  const { summary, isLoading, error, period, setPeriod } = useAiUsage('30d')

  const isEmpty = summary && summary.headline.calls === 0

  return (
    <div className="space-y-6 py-2">
      {/* No-cost privacy note — pinned at the top so the framing
          (token counts, no cost) is read before any numbers. */}
      <div className="bg-elevated border-border-default flex items-start gap-2 rounded-lg border px-4 py-3">
        <Info className="text-fg-muted mt-0.5 size-4 shrink-0" />
        <p className="text-fg-muted text-xs">{t('usage.no_cost_note')}</p>
      </div>

      {/* Period selector */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-fg-muted shrink-0 text-sm">{t('usage.period.label')}:</span>
        <div role="radiogroup" className="flex flex-wrap gap-2">
          {PERIODS.map((p) => (
            <RadioOptionPill
              key={p}
              selected={period === p}
              onClick={() => setPeriod(p)}
              className="px-3 py-1 text-xs"
              label={t(`usage.period.${p}`)}
            />
          ))}
        </div>
      </div>

      {/* Loading state */}
      {isLoading && (
        <div className="text-fg-muted flex h-20 items-center justify-center text-sm">
          {t('audit.loading')}
        </div>
      )}

      {/* Error state */}
      {!isLoading && error && (
        <div className="border-destructive/30 bg-destructive/10 text-destructive rounded-lg border px-4 py-3 text-sm">
          {error}
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !error && isEmpty && (
        <div className="text-fg-muted flex h-20 items-center justify-center text-sm">
          {t('usage.no_data')}
        </div>
      )}

      {/* Summary content */}
      {!isLoading && !error && summary && !isEmpty && (
        <>
          {/* Headline cards + per-provider */}
          <AiUsageHeadlineCards headline={summary.headline} perProvider={summary.per_provider} />

          {/* Daily chart */}
          {summary.daily.length > 0 && (
            <section>
              <AiUsageDailyChart data={summary.daily} />
            </section>
          )}

          {/* Breakdown table */}
          {summary.breakdown.length > 0 && (
            <section className="space-y-2">
              <AiUsageSectionHeading
                title={t('usage.breakdown_title')}
                help={t('usage.breakdown_help')}
              />
              <AiUsageBreakdownTable rows={summary.breakdown} />
            </section>
          )}
        </>
      )}
    </div>
  )
}
