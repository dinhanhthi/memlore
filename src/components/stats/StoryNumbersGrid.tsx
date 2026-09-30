import { useTranslation } from 'react-i18next'
import { BookOpen, CalendarDays, ChartColumn, Feather, History, Smile } from 'lucide-react'
import { useCountUp } from '../../hooks/useCountUp'
import { useStoryNumbers, type StoryNumbers } from '../../hooks/useStoryNumbers'
import { formatHour } from '../../lib/vizMath'
import { cn } from '../../lib/cn'
import type { Period } from './PeriodSelector'
import { getLevel } from './StreakCalendar'
import { HourHistogram } from './viz/HourHistogram'
import { MiniBars } from './viz/MiniBars'
import { ProgressRing } from './viz/ProgressRing'
import { Sparkline } from './viz/Sparkline'
import { SplitBars } from './viz/SplitBars'
import { StatTile } from './viz/StatTile'

/** Last ~16 weeks. A full year of cells does not fit a tile. */
const HEATMAP_DAYS = 16 * 7

const TILE_GRID = 'grid grid-cols-1 gap-4 @min-[480px]:grid-cols-2 @min-[720px]:grid-cols-3'

const PLACEHOLDER_KEYS = ['entries', 'words', 'streak', 'mood', 'year', 'hour'] as const

interface TileProps {
  story: StoryNumbers
}

function formatCount(value: number, locale: string): string {
  return value.toLocaleString(locale)
}

function heatLevelClass(count: number): string {
  const level = getLevel(count)
  if (level === 1) return 'bg-viz-5/30'
  if (level === 2) return 'bg-viz-5/50'
  if (level === 3) return 'bg-viz-5/75'
  if (level === 4) return 'bg-viz-5/100'
  return 'bg-panel-2'
}

function countActiveDays(days: StoryNumbers['heatmap']['days']): number {
  return days.reduce((total, day) => total + (day.entry_count > 0 ? 1 : 0), 0)
}

function trailingHeatmapDays(
  days: StoryNumbers['heatmap']['days'],
): StoryNumbers['heatmap']['days'] {
  return [...days].sort((a, b) => a.date.localeCompare(b.date)).slice(-HEATMAP_DAYS)
}

function EntriesTile({ story }: TileProps) {
  const { t, i18n } = useTranslation('stats')
  const count = useCountUp(story.entries.total)
  return (
    <StatTile
      tone={1}
      icon={BookOpen}
      value={formatCount(count, i18n.language)}
      label={t('story.entries', { defaultValue: 'Entries' })}
    >
      <Sparkline
        values={story.entries.series}
        tone={1}
        ariaLabel={t('story.entries_aria', { defaultValue: 'Entries over the selected period' })}
      />
    </StatTile>
  )
}

function WordsTile({ story }: TileProps) {
  const { t, i18n } = useTranslation('stats')
  const count = useCountUp(story.words.total)
  return (
    <StatTile
      tone={2}
      icon={Feather}
      value={formatCount(count, i18n.language)}
      label={t('story.words', { defaultValue: 'Words' })}
    >
      <MiniBars
        values={story.words.series}
        tone={2}
        ariaLabel={t('story.words_aria', {
          defaultValue: 'Words written over the selected period',
        })}
      />
    </StatTile>
  )
}

function StreakTile({ story }: TileProps) {
  const { t, i18n } = useTranslation('stats')
  const count = useCountUp(story.streak.current)
  const goal = Math.max(story.streak.current, story.streak.longest, 1)
  return (
    <StatTile
      tone={3}
      icon={CalendarDays}
      value={
        story.streakPending ? (
          <span
            aria-hidden="true"
            className="bg-viz-3/30 inline-block h-8 w-14 rounded-md motion-safe:animate-pulse"
          />
        ) : (
          formatCount(count, i18n.language)
        )
      }
      label={t('story.streak', { defaultValue: 'Day streak' })}
    >
      <ProgressRing
        value={story.streak.current}
        goal={goal}
        tone={3}
        ariaLabel={t('story.streak_aria', {
          defaultValue: 'Current streak against the longest streak',
        })}
      />
    </StatTile>
  )
}

function MoodTile({ story }: TileProps) {
  const { t, i18n } = useTranslation('stats')
  const { t: tEditor } = useTranslation('editor')
  const good = useCountUp(story.mood.good)
  return (
    <StatTile
      tone={4}
      icon={Smile}
      value={`${formatCount(good, i18n.language)}%`}
      label={t('story.mood', { defaultValue: 'Mood' })}
    >
      <SplitBars
        good={story.mood.good}
        neutral={story.mood.neutral}
        bad={story.mood.bad}
        labels={{
          good: tEditor('emotion.good'),
          neutral: tEditor('emotion.neutral'),
          bad: tEditor('emotion.bad'),
        }}
        ariaLabel={t('story.mood_aria', {
          defaultValue: 'Share of good, neutral, and low moods',
        })}
      />
    </StatTile>
  )
}

function YearTile({ story }: TileProps) {
  const { t, i18n } = useTranslation('stats')
  const activeDays = countActiveDays(story.heatmap.days)
  const count = useCountUp(activeDays)
  const cells = trailingHeatmapDays(story.heatmap.days)
  return (
    <StatTile
      tone={5}
      icon={ChartColumn}
      value={formatCount(count, i18n.language)}
      label={t('story.year', { defaultValue: 'This year' })}
    >
      <div
        role="img"
        aria-label={t('story.year_aria', { defaultValue: 'Days with entries this year' })}
        className="grid h-full min-h-16 w-full flex-1 auto-cols-fr grid-flow-col grid-rows-7 gap-0.5"
      >
        {cells.map((day, index) => (
          <span
            key={`${day.date}:${index}`}
            aria-hidden="true"
            className={cn('h-full min-h-1 w-full rounded-sm', heatLevelClass(day.entry_count))}
          />
        ))}
      </div>
    </StatTile>
  )
}

function HourTile({ story }: TileProps) {
  const { t, i18n } = useTranslation('stats')
  const peak = story.hours.peak
  const value = peak === null ? '—' : formatHour(peak, i18n.language)
  return (
    <StatTile
      tone={6}
      icon={History}
      value={value}
      label={t('story.hour', { defaultValue: 'Peak hour' })}
    >
      <HourHistogram
        hours={story.hours.rows}
        ariaLabel={t('story.hour_aria', { defaultValue: 'Entries by hour of day' })}
      />
    </StatTile>
  )
}

function StoryNumbersPlaceholder() {
  return (
    <div className={TILE_GRID} aria-hidden="true">
      {PLACEHOLDER_KEYS.map((key) => (
        <div key={key} className="bg-panel-2 h-48 rounded-2xl motion-safe:animate-pulse" />
      ))}
    </div>
  )
}

/**
 * Six-tile story-in-numbers hero for the Charts tab.
 * The statistics view root is already an `@container`, so these column
 * queries follow that panel width.
 */
export function StoryNumbersGrid({ period }: { period: Period }) {
  const { t } = useTranslation('stats')
  const year = new Date().getFullYear()
  const story = useStoryNumbers(period, year)

  return (
    <div className="flex flex-col gap-3">
      {story.error ? (
        <p role="alert" className="text-danger-text text-sm">
          {t('empty.load_failed')}
        </p>
      ) : null}
      {story.isLoading ? (
        <StoryNumbersPlaceholder />
      ) : (
        <div className={TILE_GRID}>
          <EntriesTile story={story} />
          <WordsTile story={story} />
          <StreakTile story={story} />
          <MoodTile story={story} />
          <YearTile story={story} />
          <HourTile story={story} />
        </div>
      )}
    </div>
  )
}
