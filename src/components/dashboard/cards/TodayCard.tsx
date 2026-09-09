import { useTranslation } from 'react-i18next'
import { useOnThisDay } from '../../../hooks/useOnThisDay'
import { getIntlLocale } from '../../../lib/dates'
import { useTabStore } from '../../../stores/tabStore'
import type { Entry } from '../../../types/entry'
import { Button } from '../../common/Button'
import { EMOTION_BY_KEY } from '../../common/emotions'
import { DashboardCard } from '../DashboardCard'

// ponytail: shares list_on_this_day with OnThisDayCard on mount; dedupe via a store if it shows in profiles
// TODO(later): docs/LATER.md — Today card does not refetch on entries-changed
export function TodayCard() {
  const { t, i18n } = useTranslation('dashboard')
  const { t: tEditor } = useTranslation('editor')
  const now = new Date()
  const { groups, isLoading, error } = useOnThisDay([
    { month: now.getMonth() + 1, day: now.getDate() },
  ])
  const currentYear = now.getFullYear()
  const todayEntries = (groups[0]?.entries ?? []).filter(
    (entry) => new Date(entry.entry_date * 1000).getFullYear() === currentYear,
  )
  const count = todayEntries.length
  const latest = todayEntries.reduce<Entry | null>(
    (best, entry) => (!best || entry.entry_date > best.entry_date ? entry : best),
    null,
  )
  const emotionMeta = latest?.emotion ? EMOTION_BY_KEY[latest.emotion] : null
  const title = new Intl.DateTimeFormat(getIntlLocale(i18n.language), {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(now)

  const handleWrite = () => {
    useTabStore.getState().updateActiveTab({ activeView: 'entries', selectedEntryId: null })
    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('memlore:new-entry'))
    })
  }

  return (
    <DashboardCard
      title={title}
      action={
        <Button variant="primary" size="xs" onClick={handleWrite}>
          {t('actions.write')}
        </Button>
      }
    >
      {isLoading ? (
        <div className="bg-panel-2 h-full rounded-lg motion-safe:animate-pulse" />
      ) : error ? (
        <p role="alert" className="text-danger-text text-sm">
          {error}
        </p>
      ) : count === 0 ? (
        <p className="text-fg-muted text-sm">{t('today.none')}</p>
      ) : (
        <div className="flex flex-col gap-1">
          <p className="text-fg text-sm">{t('today.entries', { count })}</p>
          {emotionMeta ? (
            <p className="text-fg-secondary flex items-center gap-1.5 text-xs">
              <span aria-hidden className="text-base leading-none">
                {emotionMeta.emoji}
              </span>
              <span>{tEditor(emotionMeta.i18nKey)}</span>
            </p>
          ) : null}
        </div>
      )}
    </DashboardCard>
  )
}
