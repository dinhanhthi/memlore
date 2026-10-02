import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAiBulkContextConsent } from '../../../hooks/useAiBulkContextConsent'
import { useAiDashboardInsightsEnabled } from '../../../hooks/useAiDashboardInsightsEnabled'
import { useAiInsightsEnabled } from '../../../hooks/useAiInsightsEnabled'
import { useThemeInsights } from '../../../hooks/useThemeInsights'
import { insightsRange } from '../../../lib/dashboardDates'
import { loadCachedThemeInsights } from '../../../lib/dashboardInsightsCache'
import { useTabStore } from '../../../stores/tabStore'
import type { ThemeInsightsResult } from '../../../types/ai'
import { AiIcon } from '../../common/AiIcon'
import { Button } from '../../common/Button'
import { ShimmerText } from '../../common/ShimmerText'
import { ThinkingOrb } from '../../common/ThinkingOrb'
import { AIBulkContextNoticeModal } from '../../settings/AIBulkContextNoticeModal'
import { pickThemeInsightsResult } from '../../stats/pickThemeInsightsResult'
import { DashboardCard } from '../DashboardCard'
import { DashboardNavButton } from '../DashboardNavButton'

function normaliseErrorCode(raw: string): string {
  const idx = raw.indexOf(': ')
  return idx >= 0 ? raw.slice(idx + 2).trim() : raw.trim()
}

function InsightList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-fg-muted text-xs font-medium">{title}</p>
      <ul className="text-fg-secondary list-disc space-y-0.5 pl-4 text-sm">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  )
}

export function AiInsightsCard() {
  const { t } = useTranslation('dashboard')
  const { t: tStats } = useTranslation('stats')
  const { t: tAi } = useTranslation('ai')
  const enabled = useAiDashboardInsightsEnabled()
  const insightsEnabled = useAiInsightsEnabled()
  const bulk = useAiBulkContextConsent()
  // ponytail: range computed once per mount — stale past midnight while the app stays open; recompute on visibilitychange if it matters
  // TODO(later): docs/LATER.md — recompute insights range past midnight while the app stays open
  const range = useMemo(() => insightsRange(new Date()), [])
  const [cached, setCached] = useState<ThemeInsightsResult | null>(null)

  useEffect(() => {
    if (enabled !== true) return
    let cancelled = false
    void loadCachedThemeInsights(range.start, range.end).then((result) => {
      if (!cancelled) setCached(result)
    })
    return () => {
      cancelled = true
    }
  }, [enabled, range.start, range.end])

  const insights = useThemeInsights({
    start: range.start,
    end: range.end,
    needsBulkConsent: bulk.needsBulkConsent,
    generationEndpointClass: bulk.generationEndpointClass,
  })
  const shown = pickThemeInsightsResult(insights.phase, cached)
  const phase = insights.phase

  const showGenerate =
    enabled === true &&
    insightsEnabled !== false &&
    !shown &&
    phase.kind !== 'loading' &&
    phase.kind !== 'needs_bulk_consent'

  const action = (
    <div className="flex items-center gap-1">
      {showGenerate && (
        <Button
          variant="primary"
          size="xs"
          icon={<AiIcon aria-hidden />}
          onClick={() => void insights.generate(false)}
        >
          {t('insights.generate')}
        </Button>
      )}
      <DashboardNavButton
        label={t('actions.insights')}
        onClick={() =>
          useTabStore.getState().updateActiveTab({
            activeView: 'stats',
            statsTab: 'insights',
            selectedEntryId: null,
          })
        }
      />
    </div>
  )

  if (enabled === null) {
    return (
      <DashboardCard title={t('cards.ai_insights')} action={action}>
        <div className="bg-panel-2 h-48 rounded-lg motion-safe:animate-pulse" />
      </DashboardCard>
    )
  }

  return (
    <DashboardCard title={t('cards.ai_insights')} action={action}>
      <div className="flex h-full min-h-0 flex-col gap-2">
        <div className="min-h-0 flex-1 overflow-hidden">
          {shown ? (
            <div className="flex flex-col gap-2">
              <InsightList
                title={tStats('insights.section_themes')}
                items={shown.themes.slice(0, 5)}
              />
              <InsightList
                title={tStats('insights.section_mood_drivers')}
                items={shown.moodDrivers.slice(0, 3)}
              />
            </div>
          ) : insightsEnabled === false ? (
            <p className="text-fg-muted text-sm">{tStats('insights.disabled_hint')}</p>
          ) : phase.kind === 'loading' ? (
            <div className="flex h-full flex-col items-center justify-center gap-2">
              <ThinkingOrb state="working" size={64} />
              <ShimmerText className="text-sm">{tStats('insights.generating')}</ShimmerText>
            </div>
          ) : phase.kind === 'error' ? (
            <p className="text-danger-text text-sm" role="alert">
              {tAi(`theme_insights.errors.${normaliseErrorCode(phase.code)}`, {
                defaultValue: tAi('theme_insights.errors.unknown', {
                  defaultValue: 'Could not generate insights ({{code}}).',
                  code: normaliseErrorCode(phase.code),
                }),
              })}
            </p>
          ) : null}
        </div>
        <p className="text-fg-muted shrink-0 text-xs">{t('insights.range_hint')}</p>
      </div>
      {phase.kind === 'needs_bulk_consent' && (
        <AIBulkContextNoticeModal
          endpointClass={phase.endpointClass}
          providerLabel={bulk.providerLabel ?? phase.endpointClass}
          entryCount={phase.entryCount}
          start={phase.start}
          end={phase.end}
          onCancel={insights.dismiss}
          onAccept={(cls) => {
            void bulk.acceptBulkContext(cls).then(() => insights.confirmBulkConsent())
          }}
        />
      )}
    </DashboardCard>
  )
}
