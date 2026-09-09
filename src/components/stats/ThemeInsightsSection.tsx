import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'
import { Button } from '../common/Button'
import { AiIcon } from '../common/AiIcon'
import { ShimmerText } from '../common/ShimmerText'
import { InlineOrb } from '../common/ThinkingOrb'
import { AIBulkContextNoticeModal } from '../settings/AIBulkContextNoticeModal'
import { useAiBulkContextConsent } from '../../hooks/useAiBulkContextConsent'
import { useAiInsightsEnabled } from '../../hooks/useAiInsightsEnabled'
import { useThemeInsights } from '../../hooks/useThemeInsights'
import { cn } from '../../lib/cn'
import { getAiProviders } from '../../lib/tauri'
import type { EndpointClass, ThemeInsightsResult } from '../../types/ai'
import { pickThemeInsightsResult, themeInsightsRegenerateFlag } from './pickThemeInsightsResult'

function normaliseErrorCode(raw: string): string {
  const idx = raw.indexOf(': ')
  return idx >= 0 ? raw.slice(idx + 2).trim() : raw.trim()
}

export interface ThemeInsightsSectionProps {
  start: number
  end: number
  cached?: ThemeInsightsResult | null
  /** When false, drop the bordered card chrome so a parent (e.g. DashboardCard) can host it. */
  framed?: boolean
}

/**
 * On-demand AI theme / mood-driver analysis for a date range.
 * Never generates on mount — only from the Generate / Regenerate button.
 */
export function ThemeInsightsSection({
  start,
  end,
  cached = null,
  framed = true,
}: ThemeInsightsSectionProps) {
  const { t } = useTranslation('stats')
  const { t: tAi } = useTranslation('ai')
  const enabled = useAiInsightsEnabled()
  const bulk = useAiBulkContextConsent()
  const [providerClass, setProviderClass] = useState<EndpointClass | null>(null)
  const [providersReady, setProvidersReady] = useState(false)

  const insights = useThemeInsights({
    start,
    end,
    needsBulkConsent: bulk.needsBulkConsent,
    generationEndpointClass: providerClass,
  })

  useEffect(() => {
    let cancelled = false
    getAiProviders()
      .then((p) => {
        if (!cancelled) setProviderClass(p.generation?.endpointClass ?? null)
      })
      .catch(() => {
        if (!cancelled) setProviderClass(null)
      })
      .finally(() => {
        if (!cancelled) setProvidersReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const phase = insights.phase
  const lastReadyRef = useRef<ThemeInsightsResult | null>(null)
  if (phase.kind === 'ready') lastReadyRef.current = phase.result
  const shown = pickThemeInsightsResult(phase, cached, lastReadyRef.current)
  const themesLoading = phase.kind === 'loading'
  const hasResult = shown != null
  const gatesLoading = enabled === null || bulk.loading || !providersReady
  const gate = gatesLoading
    ? 'loading'
    : enabled === false
      ? 'disabled'
      : !providerClass
        ? 'needs_provider'
        : providerClass !== 'local' && bulk.settings?.privacyAcceptedAt == null
          ? 'needs_privacy'
          : 'generate'

  return (
    <section
      className={cn(
        'space-y-4',
        framed && 'border-border-default bg-elevated rounded-2xl border p-4',
      )}
    >
      <div>
        <h3 className="text-fg text-sm font-semibold">
          {t('insights.ai_themes_title', { defaultValue: 'AI themes for this period' })}
        </h3>
        <p className="text-fg-muted mt-1 text-xs leading-relaxed">
          {t('insights.ai_themes_description')}
        </p>
      </div>

      {gate === 'loading' && !shown ? (
        <div className="text-fg-muted flex items-center gap-2 text-sm">
          <InlineOrb state="searching" aria-hidden />
          <ShimmerText className="text-sm">
            {tAi('period_review.loading_settings', { defaultValue: 'Loading AI settings…' })}
          </ShimmerText>
        </div>
      ) : gate === 'disabled' ? (
        <p className="text-fg-muted text-sm">{t('insights.disabled_hint')}</p>
      ) : gate === 'needs_provider' ? (
        <p className="text-fg-muted text-sm">{t('insights.needs_provider_hint')}</p>
      ) : gate === 'needs_privacy' ? (
        <p className="text-fg-muted text-sm">{t('insights.needs_privacy_hint')}</p>
      ) : gate === 'generate' ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {framed ? (
              <>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={themesLoading}
                  icon={<AiIcon aria-hidden />}
                  onClick={() =>
                    void insights.generate(themeInsightsRegenerateFlag('generate', hasResult))
                  }
                >
                  <span>
                    {themesLoading
                      ? t('insights.generating', { defaultValue: 'Analyzing…' })
                      : t('insights.generate', { defaultValue: 'Generate themes' })}
                  </span>
                </Button>
                {hasResult && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={themesLoading}
                    onClick={() =>
                      void insights.generate(themeInsightsRegenerateFlag('regenerate', hasResult))
                    }
                  >
                    <RefreshCw className="size-4" aria-hidden />
                    {t('insights.regenerate', { defaultValue: 'Regenerate' })}
                  </Button>
                )}
              </>
            ) : (
              <Button
                variant="primary"
                size="sm"
                disabled={themesLoading}
                icon={<AiIcon aria-hidden />}
                onClick={() =>
                  void insights.generate(themeInsightsRegenerateFlag('compact', hasResult))
                }
              >
                <span>
                  {themesLoading
                    ? t('insights.generating', { defaultValue: 'Analyzing…' })
                    : hasResult
                      ? t('insights.regenerate', { defaultValue: 'Regenerate' })
                      : t('insights.generate', { defaultValue: 'Generate themes' })}
                </span>
              </Button>
            )}
          </div>

          {phase.kind === 'error' && (
            <p className="text-danger-text text-sm" role="alert">
              {tAi(`theme_insights.errors.${normaliseErrorCode(phase.code)}`, {
                defaultValue: tAi('theme_insights.errors.unknown', {
                  defaultValue: 'Could not generate insights ({{code}}).',
                  code: normaliseErrorCode(phase.code),
                }),
              })}
            </p>
          )}
        </>
      ) : null}

      {shown && (
        <div className="space-y-4">
          {shown.cached && (
            <p className="text-fg-muted text-xs">
              {t('insights.cached_hint', { defaultValue: 'Loaded from cache.' })}
            </p>
          )}
          <InsightList
            title={t('insights.section_themes', { defaultValue: 'Recurring themes' })}
            items={shown.themes}
            empty={t('insights.section_empty', { defaultValue: 'None noted.' })}
          />
          <InsightList
            title={t('insights.section_mood_drivers', {
              defaultValue: 'Likely mood drivers',
            })}
            items={shown.moodDrivers}
            empty={t('insights.section_empty', { defaultValue: 'None noted.' })}
          />
          <p className="text-fg-muted text-xs">
            {t('insights.entry_count', {
              defaultValue: 'Based on {{count}} entries',
              count: shown.entryCount,
            })}
          </p>
        </div>
      )}

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
    </section>
  )
}

interface InsightListProps {
  title: string
  items: string[]
  empty: string
}

function InsightList({ title, items, empty }: InsightListProps) {
  return (
    <div>
      <h4 className="text-fg text-sm font-semibold">{title}</h4>
      {items.length === 0 ? (
        <p className="text-fg-muted mt-2 text-sm">{empty}</p>
      ) : (
        <ul className="text-fg-secondary mt-2 list-disc space-y-1 pl-5 text-sm leading-relaxed">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
