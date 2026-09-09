import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react'
import { Button } from '../common/Button'
import { AiIcon } from '../common/AiIcon'
import { SegmentedControl } from '../common/SegmentedControl'
import { ShimmerText } from '../common/ShimmerText'
import { InlineOrb } from '../common/ThinkingOrb'
import { AIBulkContextNoticeModal } from '../settings/AIBulkContextNoticeModal'
import { useAiBulkContextConsent } from '../../hooks/useAiBulkContextConsent'
import { useAiPeriodicReviewEnabled } from '../../hooks/useAiPeriodicReviewEnabled'
import { usePeriodReview } from '../../hooks/usePeriodReview'
import { formatDateRange, formatEntryDateWithYear } from '../../lib/dates'
import { shiftPeriodAnchor } from '../../lib/periodReview'
import { getAiProviders } from '../../lib/tauri'
import type { EndpointClass, PeriodReviewKind } from '../../types/ai'
import { useEffect } from 'react'

function normaliseErrorCode(raw: string): string {
  const idx = raw.indexOf(': ')
  return idx >= 0 ? raw.slice(idx + 2).trim() : raw.trim()
}

/**
 * Weekly/monthly AI period review — highlights, lowlights, themes, and
 * one synthesizing insight. Lives under Statistics → Reviews.
 */
export function PeriodReviewView() {
  const { t, i18n } = useTranslation('ai')
  const enabled = useAiPeriodicReviewEnabled()
  const bulk = useAiBulkContextConsent()
  const [kind, setKind] = useState<PeriodReviewKind>('weekly')
  const [anchorSec, setAnchorSec] = useState(() => Math.floor(Date.now() / 1000))
  const [providerClass, setProviderClass] = useState<EndpointClass | null>(null)

  useEffect(() => {
    getAiProviders()
      .then((p) => setProviderClass(p.generation?.endpointClass ?? null))
      .catch(() => setProviderClass(null))
  }, [])

  const review = usePeriodReview({
    kind,
    anchorSec,
    locale: i18n.language,
    needsBulkConsent: bulk.needsBulkConsent,
    generationEndpointClass: providerClass,
  })

  const rangeLabel = useMemo(
    () => formatDateRange(review.bounds.start, review.bounds.end, i18n.language),
    [review.bounds.end, review.bounds.start, i18n.language],
  )

  const periodKindLabel =
    kind === 'weekly'
      ? t('period_review.kind_weekly', { defaultValue: 'Week' })
      : t('period_review.kind_monthly', { defaultValue: 'Month' })

  function shift(delta: -1 | 1) {
    setAnchorSec((prev) => shiftPeriodAnchor(kind, prev, delta, i18n.language))
  }

  if (enabled === null || bulk.loading) {
    return (
      <div className="text-fg-muted flex items-center gap-2 py-8 text-sm">
        <InlineOrb state="searching" aria-hidden />
        <ShimmerText className="text-sm">
          {t('period_review.loading_settings', { defaultValue: 'Loading AI settings…' })}
        </ShimmerText>
      </div>
    )
  }

  if (enabled === false) {
    return (
      <div className="border-border-default bg-panel-2 rounded-lg border px-4 py-6 text-sm">
        <p className="text-fg font-medium">
          {t('period_review.disabled_title', { defaultValue: 'Periodic reviews are off' })}
        </p>
        <p className="text-fg-muted mt-1 leading-relaxed">
          {t('period_review.disabled_body', {
            defaultValue:
              'Enable “Periodic reviews” in Settings → AI to generate weekly or monthly recaps.',
          })}
        </p>
      </div>
    )
  }

  if (!providerClass) {
    return (
      <div className="border-border-default bg-panel-2 rounded-lg border px-4 py-6 text-sm">
        <p className="text-fg font-medium">
          {t('period_review.needs_provider_title', { defaultValue: 'Set up an AI provider' })}
        </p>
        <p className="text-fg-muted mt-1 leading-relaxed">
          {t('period_review.needs_provider_body', {
            defaultValue:
              'Configure a generation provider in Settings → AI before generating a period review.',
          })}
        </p>
      </div>
    )
  }

  const privacyAccepted = providerClass === 'local' || bulk.settings?.privacyAcceptedAt != null
  if (!privacyAccepted) {
    return (
      <div className="border-border-default bg-panel-2 rounded-lg border px-4 py-6 text-sm">
        <p className="text-fg font-medium">
          {t('period_review.needs_privacy_title', { defaultValue: 'Privacy notice required' })}
        </p>
        <p className="text-fg-muted mt-1 leading-relaxed">
          {t('period_review.needs_privacy_body', {
            defaultValue: 'Accept the AI privacy notice in Settings → AI first.',
          })}
        </p>
      </div>
    )
  }

  const phase = review.phase
  const loading = phase.kind === 'loading'
  const hasResult = phase.kind === 'ready'

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="font-display text-fg text-lg font-semibold">
          {t('period_review.title', { defaultValue: 'Period reviews' })}
        </h2>
        <p className="text-fg-muted mt-1 text-sm leading-relaxed">
          {t('period_review.description', {
            defaultValue:
              'AI-written recaps of your journal — highlights, lowlights, recurring themes, and one insight for the period.',
          })}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl
          options={[
            { value: 'weekly', label: t('period_review.kind_weekly', { defaultValue: 'Week' }) },
            { value: 'monthly', label: t('period_review.kind_monthly', { defaultValue: 'Month' }) },
          ]}
          value={kind}
          onChange={(v) => {
            setKind(v)
          }}
          ariaLabel={t('period_review.kind_aria', { defaultValue: 'Review period kind' })}
        />

        <div className="border-border-default flex shrink-0 items-center gap-1 rounded-lg border">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => shift(-1)}
            aria-label={t('period_review.prev_period', {
              defaultValue: 'Previous {{kind}}',
              kind: periodKindLabel,
            })}
          >
            <ChevronLeft className="size-4" aria-hidden />
          </Button>
          <span className="text-fg min-w-40 px-2 text-center text-sm font-medium">
            {rangeLabel}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => shift(1)}
            aria-label={t('period_review.next_period', {
              defaultValue: 'Next {{kind}}',
              kind: periodKindLabel,
            })}
          >
            <ChevronRight className="size-4" aria-hidden />
          </Button>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {!hasResult && (
            <Button
              variant="primary"
              size="sm"
              loading={loading}
              loadingError={phase.kind === 'error'}
              announceOnSettle={t('announcer.review_ready')}
              icon={<AiIcon aria-hidden />}
              onClick={() => void review.generate(false)}
            >
              <span>
                {loading
                  ? t('period_review.generating', { defaultValue: 'Generating…' })
                  : t('period_review.generate', { defaultValue: 'Generate review' })}
              </span>
            </Button>
          )}

          {hasResult && (
            <Button
              variant="secondary"
              size="sm"
              disabled={loading}
              onClick={() => void review.generate(true)}
            >
              <RefreshCw className="size-4" aria-hidden />
              {t('period_review.regenerate', { defaultValue: 'Regenerate' })}
            </Button>
          )}
        </div>
      </div>

      {phase.kind === 'error' && (
        <p className="text-danger-text text-sm" role="alert">
          {t(`period_review.errors.${normaliseErrorCode(phase.code)}`, {
            defaultValue: t('period_review.errors.unknown', {
              defaultValue: 'Could not generate review ({{code}}).',
              code: normaliseErrorCode(phase.code),
            }),
          })}
        </p>
      )}

      {hasResult && (
        <article className="border-border-default bg-elevated space-y-5 rounded-lg border p-4">
          <p className="text-fg-muted text-xs">
            {t('period_review.generated_at', {
              defaultValue: 'Generated {{date}}',
              date: formatEntryDateWithYear(phase.result.createdAt, i18n.language),
            })}
          </p>
          <ReviewSection
            title={t('period_review.section_highlights', { defaultValue: 'Highlights' })}
            items={phase.result.highlights}
            empty={t('period_review.section_empty', { defaultValue: 'None noted.' })}
          />
          <ReviewSection
            title={t('period_review.section_lowlights', { defaultValue: 'Lowlights' })}
            items={phase.result.lowlights}
            empty={t('period_review.section_empty', { defaultValue: 'None noted.' })}
          />
          <ReviewSection
            title={t('period_review.section_themes', { defaultValue: 'Recurring themes' })}
            items={phase.result.themes}
            empty={t('period_review.section_empty', { defaultValue: 'None noted.' })}
          />
          <div>
            <h3 className="text-fg text-sm font-semibold">
              {t('period_review.section_insight', { defaultValue: 'Insight' })}
            </h3>
            <p className="text-fg-secondary mt-2 text-sm leading-relaxed">{phase.result.insight}</p>
          </div>
          <p className="text-fg-muted text-xs">
            {t('period_review.entry_count', {
              defaultValue: 'Based on {{count}} entries',
              count: phase.result.entryCount,
            })}
          </p>
        </article>
      )}

      {phase.kind === 'needs_bulk_consent' && (
        <AIBulkContextNoticeModal
          endpointClass={phase.endpointClass}
          providerLabel={bulk.providerLabel ?? phase.endpointClass}
          entryCount={phase.entryCount}
          start={phase.start}
          end={phase.end}
          onCancel={review.dismiss}
          onAccept={(cls) => {
            void bulk.acceptBulkContext(cls).then(() => review.confirmBulkConsent())
          }}
        />
      )}
    </div>
  )
}

interface ReviewSectionProps {
  title: string
  items: string[]
  empty: string
}

function ReviewSection({ title, items, empty }: ReviewSectionProps) {
  return (
    <div>
      <h3 className="text-fg text-sm font-semibold">{title}</h3>
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
