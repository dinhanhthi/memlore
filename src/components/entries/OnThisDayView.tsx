import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useOnThisDay } from '../../hooks/useOnThisDay'
import type { DatePoint, DateGroup } from '../../hooks/useOnThisDay'
import { EMPTY_TAGS, useEntryTags } from '../../hooks/useEntryTags'
import { useSelectedEntryId, useUpdateActiveTab } from '../../hooks/useActiveTab'
import { useJournals } from '../../hooks/useJournals'
import { cn } from '../../lib/cn'
import { getEntryListFilter, useUiStore } from '../../stores/uiStore'
import { EntryCard } from './EntryCard'
import EntryListSkeleton from './EntryListSkeleton'
import { ENTRY_CARD_IDLE_BG } from './entryCardIdleBg'
import { AiSummaryTrigger } from '../ai/AiSummaryTrigger'
import { RadioOptionPill } from '../common/RadioOptionPill'
import { JournalScopePicker } from '../journals/JournalScopePicker'
import { SyncCatchupBanner } from '../common/SyncCatchupBanner'
import { RestoredScroll } from '../common/RestoredScroll'
import { SecondPanel } from '../layout/SecondPanel'
import { getSetting, setSetting } from '../../lib/tauri'
import type { Entry } from '../../types/entry'

type Range = 'same_day' | 'around_3_days' | 'around_1_week'

const RANGE_OFFSETS: Record<Range, number[]> = {
  same_day: [0],
  around_3_days: [-3, -2, -1, 0, 1, 2, 3],
  around_1_week: [-7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7],
}

const SETTING_KEY = 'on_this_day_range'

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/** Relative label for a signed offset from today. */
function relativeLabel(offset: number): string {
  if (offset === 0) return 'Today'
  if (offset === -1) return 'Yesterday'
  if (offset === 1) return 'Tomorrow'
  const n = Math.abs(offset)
  return offset < 0 ? `${n} Days Ago` : `In ${n} Days`
}

/** Compute calendar dates for the given signed offsets from today, handles month/year rollover. */
function buildDates(offsets: number[]): DatePoint[] {
  return offsets.map((offset) => {
    const d = new Date()
    d.setDate(d.getDate() + offset)
    return { month: d.getMonth() + 1, day: d.getDate() }
  })
}

/**
 * "On This Day" throwback view — shows entries from today and nearby calendar
 * dates across all past years. Each date is a section with a relative label
 * and entries grouped by year descending. The user can choose the date window
 * width (just today, ±3 days, or ±1 week) and the preference persists via the
 * settings table.
 */
export function OnThisDayView() {
  const { t } = useTranslation('nav')
  const [range, setRange] = useState<Range>('around_3_days')
  const designSystem = useUiStore((s) => s.designSystem)
  const isClay = designSystem === 'clay'

  useEffect(() => {
    let cancelled = false
    getSetting(SETTING_KEY)
      .then((v) => {
        if (cancelled) return
        if (v === 'same_day' || v === 'around_3_days' || v === 'around_1_week') {
          setRange(v)
        }
      })
      .catch(() => {
        // Silent — keep default range on read failure.
      })
    return () => {
      cancelled = true
    }
  }, [])

  function handleSelectRange(next: Range) {
    setRange(next)
    setSetting(SETTING_KEY, next).catch(() => {
      // Silent — UI state already updated; persistence failure is non-fatal.
    })
  }

  const offsets = RANGE_OFFSETS[range]
  const selectedJournalId = useUiStore((s) => getEntryListFilter(s, 'onthisday').journalId)
  const setEntryListJournalId = useUiStore((s) => s.setEntryListJournalId)

  // Build the dates on every render so that a session crossing local midnight
  // picks up the new dates the next time React re-renders this view. The hook's
  // datesKey serialisation prevents redundant backend calls when values are
  // unchanged.
  const { groups, error, isEmpty, isLoading } = useOnThisDay(buildDates(offsets), selectedJournalId)
  const entryTags = useEntryTags(groups.flatMap((group) => group.entries.map((entry) => entry.id)))
  const selectedEntryId = useSelectedEntryId()
  const updateActiveTab = useUpdateActiveTab()
  const { journals } = useJournals()

  return (
    <SecondPanel data-testid="on-this-day-view">
      {/* Sticky header — title + filter chips stay fixed at the top.
          `-mb-px` + opaque bg + z-30 make this header overlap the scroll
          container's first pixel row and paint over it. The panel is nested
          under a fractional-height titlebar, so the header/scroll boundary
          lands on a sub-pixel row (~.875); Tauri's WebKit rounds the scroll
          layer's composited top differently from Chromium and bleeds a
          hairline of scrolling content through that seam. Overlapping the seam
          with the opaque header masks it. Web/Chromium is unaffected either way. */}
      {/* Clay: the tray paints a top-lit wash, so the header stays transparent
          (the seam mask below is a Signature/Clean WebKit workaround). */}
      <div className={cn('relative z-30 -mb-px shrink-0 px-4 pt-4', !isClay && 'bg-selected-tab')}>
        <h1 className="font-title text-fg mb-4 text-2xl font-extrabold">
          {t('onthisday_view.title')}
        </h1>

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <JournalScopePicker
            journalId={selectedJournalId}
            journals={journals}
            onChange={(journalId) => {
              setEntryListJournalId('onthisday', journalId)
              // Guard the null→null case: the filter lives in uiStore, not the
              // tab NavSnapshot, so an unconditional patch would push a phantom
              // history entry that Back can't undo (see tabStore.ts C1).
              if (selectedEntryId !== null) updateActiveTab({ selectedEntryId: null })
            }}
          />
          <div
            role="radiogroup"
            aria-label={t('onthisday_view.range_aria')}
            className="flex flex-wrap gap-2"
          >
            <RadioOptionPill
              selected={range === 'same_day'}
              onClick={() => handleSelectRange('same_day')}
              className="px-3 py-1 text-xs"
              label={t('onthisday_view.range.same_day')}
            />
            <RadioOptionPill
              selected={range === 'around_3_days'}
              onClick={() => handleSelectRange('around_3_days')}
              className="px-3 py-1 text-xs"
              label={t('onthisday_view.range.around_3_days')}
            />
            <RadioOptionPill
              selected={range === 'around_1_week'}
              onClick={() => handleSelectRange('around_1_week')}
              className="px-3 py-1 text-xs"
              label={t('onthisday_view.range.around_1_week')}
            />
          </div>
        </div>

        {error && (
          <p className="text-fg-muted mb-3 text-sm" role="alert">
            {error}
          </p>
        )}
      </div>

      {/* Scrollable entries list — only this region scrolls. */}
      <RestoredScroll
        view="onthisday"
        ready={!isLoading}
        className="flex flex-1 flex-col overflow-y-auto pb-4"
      >
        {isLoading && !error && <EntryListSkeleton paginator={false} />}

        {!isLoading && !error && isEmpty && (
          <p className="text-fg-muted mt-8 px-4 text-center text-sm">{t('onthisday_view.empty')}</p>
        )}

        {!isLoading &&
          !error &&
          groups.map((group: DateGroup, index: number) => {
            if (group.entries.length === 0) return null

            // `groups` preserves input order from useOnThisDay (see hook), so offsets[index]
            // is the same offset that produced this group.
            const label = relativeLabel(offsets[index])
            const dateLabel = `${MONTHS[group.date.month - 1]} ${group.date.day}`
            const groupedByYear = groupByYearDescending(group.entries)

            return (
              <AiSummaryTrigger.Root
                key={`${group.date.month}-${group.date.day}`}
                entries={group.entries.map((e) => ({
                  id: e.id,
                  title: e.title,
                  content_text: e.content_text,
                  entry_date: e.entry_date,
                }))}
              >
                <section className="mb-6">
                  <div className="bg-selected-tab sticky top-0 z-20 flex items-center gap-3 py-2 pr-2 pl-4">
                    <p className="text-accent-text/80 text-2xs font-semibold tracking-[0.8px] uppercase">
                      {label}
                    </p>
                    <div className="border-border-default flex-1 border-t" />
                    <h2 className="text-accent-text/80 text-xs font-semibold">{dateLabel}</h2>
                    <AiSummaryTrigger.Button size="sm" />
                  </div>

                  <div className="px-4">
                    <AiSummaryTrigger.Banner />
                  </div>

                  {groupedByYear.map(([year, yearEntries]) => (
                    <div key={year}>
                      <div
                        className={cn(
                          'relative flex items-center border-b py-2 pl-4',
                          'border-border-default bg-panel-2',
                          // Accent sweep in every skin — same as the entry-list date
                          // headers; a plain gray row collides with card hover.
                          "before:from-accent/25 before:pointer-events-none before:absolute before:inset-0 before:bg-linear-to-r before:to-transparent before:content-['']",
                        )}
                      >
                        <h3 className="text-fg-muted text-2xs relative z-10 font-mono font-medium tracking-[0.8px] uppercase">
                          {year}
                        </h3>
                      </div>
                      <div className="flex flex-col">
                        {yearEntries.map((entry) => (
                          <EntryCard
                            key={entry.id}
                            entry={entry}
                            isSelected={selectedEntryId === entry.id}
                            onClick={() => updateActiveTab({ selectedEntryId: entry.id })}
                            journal={journals.find((j) => j.id === entry.journal_id) ?? null}
                            tags={entryTags.get(entry.id) ?? EMPTY_TAGS}
                            idleBg={ENTRY_CARD_IDLE_BG}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </section>
              </AiSummaryTrigger.Root>
            )
          })}
      </RestoredScroll>

      <footer className="shrink-0 p-0 empty:hidden">
        <SyncCatchupBanner />
      </footer>
    </SecondPanel>
  )
}

/** Group entries by local year, newest first. */
function groupByYearDescending(entries: Entry[]): Array<[number, Entry[]]> {
  const byYear = new Map<number, Entry[]>()
  for (const entry of entries) {
    const year = new Date(entry.entry_date * 1000).getFullYear()
    const list = byYear.get(year)
    if (list) list.push(entry)
    else byYear.set(year, [entry])
  }
  return [...byYear.entries()].sort(([a], [b]) => b - a)
}
