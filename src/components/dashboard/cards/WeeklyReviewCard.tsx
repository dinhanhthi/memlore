import { useMemo } from 'react'
import { ArrowRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAiBulkContextConsent } from '../../../hooks/useAiBulkContextConsent'
import { usePeriodReview } from '../../../hooks/usePeriodReview'
import { formatDateRange } from '../../../lib/dates'
import { shiftPeriodAnchor } from '../../../lib/periodReview'
import { useTabStore } from '../../../stores/tabStore'
import { AiIcon } from '../../common/AiIcon'
import { Button } from '../../common/Button'
import { ShimmerText } from '../../common/ShimmerText'
import { AIBulkContextNoticeModal } from '../../settings/AIBulkContextNoticeModal'
import { DashboardCard } from '../DashboardCard'

function normaliseErrorCode(raw: string): string {
  const idx = raw.indexOf(': ')
  return idx >= 0 ? raw.slice(idx + 2).trim() : raw.trim()
}

export function WeeklyReviewCard() {
  const { t, i18n } = useTranslation('dashboard')
  const { t: tAi } = useTranslation('ai')
  const bulk = useAiBulkContextConsent()
  const anchorSec = useMemo(
    () => shiftPeriodAnchor('weekly', Math.floor(Date.now() / 1000), -1, i18n.language),
    [i18n.language],
  )
  // TODO(later): docs/LATER.md — weekly review anchor computed once per mount (same midnight staleness as #73)
  const review = usePeriodReview({
    kind: 'weekly',
    anchorSec,
    locale: i18n.language,
    needsBulkConsent: bulk.needsBulkConsent,
    generationEndpointClass: bulk.generationEndpointClass,
  })
  const phase = review.phase
  const rangeLabel = useMemo(
    () => formatDateRange(review.bounds.start, review.bounds.end, i18n.language),
    [review.bounds.end, review.bounds.start, i18n.language],
  )

  const showGenerate =
    phase.kind !== 'ready' && phase.kind !== 'loading' && phase.kind !== 'needs_bulk_consent'
  const action = (
    <div className="flex items-center gap-1">
      {showGenerate && (
        <Button
          variant="primary"
          size="xs"
          icon={<AiIcon aria-hidden />}
          onClick={() => void review.generate(false)}
        >
          {t('weekly_review.generate')}
        </Button>
      )}
      <Button
        variant="ghost"
        size="xs"
        icon={<ArrowRight className="size-4" />}
        onClick={() =>
          useTabStore.getState().updateActiveTab({
            activeView: 'stats',
            statsTab: 'reviews',
            selectedEntryId: null,
          })
        }
      >
        {t('actions.reviews')}
      </Button>
    </div>
  )

  return (
    <DashboardCard title={t('cards.weekly_review')} action={action}>
      <div className="flex h-full min-h-0 flex-col gap-2">
        <div className="min-h-0 flex-1 overflow-hidden">
          {phase.kind === 'ready' ? (
            <div className="flex flex-col gap-1.5">
              <ul className="m-0 list-none p-0">
                {phase.result.highlights.slice(0, 3).map((item, i) => (
                  <li key={`highlight-${i}`} className="text-fg truncate text-sm">
                    {item}
                  </li>
                ))}
              </ul>
              <p className="text-fg-secondary line-clamp-3 text-xs">{phase.result.insight}</p>
            </div>
          ) : phase.kind === 'loading' ? (
            <ShimmerText className="text-sm">{t('weekly_review.generating')}</ShimmerText>
          ) : phase.kind === 'error' ? (
            <p className="text-danger-text text-sm" role="alert">
              {tAi(`period_review.errors.${normaliseErrorCode(phase.code)}`, {
                defaultValue: tAi('period_review.errors.unknown', {
                  defaultValue: 'Could not generate review ({{code}}).',
                  code: normaliseErrorCode(phase.code),
                }),
              })}
            </p>
          ) : (
            <p className="text-fg-muted text-sm">{t('weekly_review.empty')}</p>
          )}
        </div>
        <p className="text-fg-muted shrink-0 text-xs">{rangeLabel}</p>
      </div>
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
    </DashboardCard>
  )
}
