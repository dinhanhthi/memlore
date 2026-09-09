import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  shift,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  useSelectedCalendarDate,
  useSelectedEntryId,
  useUpdateActiveTab,
} from '../../hooks/useActiveTab'
import { useEntryDates } from '../../hooks/useEntryDates'
import { useEntryEmotionByDate } from '../../hooks/useEntryEmotionByDate'
import { EMPTY_TAGS, useEntryTags } from '../../hooks/useEntryTags'
import { EMOTION_BY_KEY } from '../common/emotions'
import { useTheme } from '../../hooks/useTheme'
import { cn } from '../../lib/cn'
import { useUiStore } from '../../stores/uiStore'
import { toISODate } from '../../lib/dates'
import { useEntriesForDate } from '../../hooks/useEntriesForDate'
import { useJournalStore } from '../../stores/journalStore'
import { AiSummaryTrigger } from '../ai/AiSummaryTrigger'
import { RestoredScroll } from '../common/RestoredScroll'
import { Button } from '../common/Button'
import { IconButton } from '../common/primitives'
import { EntryCard } from '../entries/EntryCard'
import { ENTRY_CARD_IDLE_BG } from '../entries/entryCardIdleBg'
import { SecondPanel } from '../layout/SecondPanel'

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

function getFirstDayOfWeek(year: number, month: number): number {
  return new Date(year, month, 1).getDay()
}

function monthYearFromISO(iso: string | null): { year: number; month: number } {
  if (iso) {
    const d = new Date(`${iso}T12:00:00`)
    if (!Number.isNaN(d.getTime())) {
      return { year: d.getFullYear(), month: d.getMonth() }
    }
  }
  const now = new Date()
  return { year: now.getFullYear(), month: now.getMonth() }
}

export function CalendarPanel() {
  // Snapshot "now" at mount so render stays pure, and refresh it on
  // window/tab focus so the panel doesn't get stuck on yesterday when
  // the user leaves the app open past midnight. Seed month/year from
  // the tab's selected date so remount keeps the visible month.
  const selectedCalendarDate = useSelectedCalendarDate()
  const designSystem = useUiStore((s) => s.designSystem)
  const isClean = designSystem === 'clean'
  const [todayISO, setTodayISO] = useState(() => toISODate(Math.floor(Date.now() / 1000)))
  const [currentYear, setCurrentYear] = useState(() => monthYearFromISO(selectedCalendarDate).year)
  const [currentMonth, setCurrentMonth] = useState(
    () => monthYearFromISO(selectedCalendarDate).month,
  )

  useEffect(() => {
    const refresh = () => {
      if (document.hidden) return
      setTodayISO(toISODate(Math.floor(Date.now() / 1000)))
    }
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('focus', refresh)
    return () => {
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  const [monthPickerOpen, setMonthPickerOpen] = useState(false)
  const [yearPickerOpen, setYearPickerOpen] = useState(false)
  // Anchor for the 12-year decade grid in the year picker. Re-aligns to the
  // selected year each time the popover opens so the user always sees the
  // current year in-frame.
  const [yearGridStart, setYearGridStart] = useState(
    () => Math.floor(new Date().getFullYear() / 12) * 12,
  )

  const { i18n, t } = useTranslation('nav')
  const { t: tEditor } = useTranslation('editor')
  const locale = i18n.language || 'en-US'

  const selectedEntryId = useSelectedEntryId()
  const updateActiveTab = useUpdateActiveTab()
  const journals = useJournalStore((s) => s.journals)
  const activeJournalId = useJournalStore((s) => s.activeJournalId)

  // Full set of entry_date timestamps for the active journal scope. Used for
  // the per-day heatmap dots — does NOT paginate, stays cheap even at 10k entries.
  const { dates: entryDates, refetch: refetchDates } = useEntryDates(activeJournalId)
  // Refresh the heatmap whenever the entry list changes (create / delete).
  // useEntries fires 'memlore:entries-changed' after every mutation that
  // shifts day-bucket counts; CalendarPanel listens and re-fetches dates.
  useEffect(() => {
    const handler = () => {
      void refetchDates()
    }
    window.addEventListener('memlore:entries-changed', handler)
    return () => window.removeEventListener('memlore:entries-changed', handler)
  }, [refetchDates])

  const journalMap = useMemo(() => {
    const map = new Map<string, (typeof journals)[0]>()
    for (const j of journals) map.set(j.id, j)
    return map
  }, [journals])

  // Per-day emotion for the month-grid dot indicator — `daysWithEntries`
  // answers "did the user write?" and `emotionByDate` answers "how did
  // they feel?".
  const { data: emotionByDate } = useEntryEmotionByDate(currentYear)
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'

  const daysInMonth = getDaysInMonth(currentYear, currentMonth)
  const firstDayOfWeek = getFirstDayOfWeek(currentYear, currentMonth)

  const monthLabel = new Date(currentYear, currentMonth, 1).toLocaleDateString(locale, {
    month: 'long',
    year: 'numeric',
  })

  // Days in this month that have at least one entry. Derived from the full set
  // of entry_date timestamps fetched by useEntryDates (not the paginated store).
  const daysWithEntries = useMemo(() => {
    const set = new Set<string>()
    for (const ts of entryDates) {
      const iso = toISODate(ts)
      const [y, m] = iso.split('-').map(Number)
      if (y === currentYear && m === currentMonth + 1) {
        set.add(iso)
      }
    }
    return set
  }, [entryDates, currentYear, currentMonth])
  // Entries written on the selected day. Uses a dedicated hook (not the paged
  // useEntries) so the calendar doesn't contend with EntryList for the per-tab
  // pagination state stored under `journal:${id}`.
  const { entries: selectedDateEntries, isLoading: dateEntriesLoading } = useEntriesForDate(
    activeJournalId,
    selectedCalendarDate,
  )
  const entryTags = useEntryTags(selectedDateEntries.map((entry) => entry.id))

  const prevMonth = () => {
    if (currentMonth === 0) {
      setCurrentYear((y) => y - 1)
      setCurrentMonth(11)
    } else {
      setCurrentMonth((m) => m - 1)
    }
  }

  const nextMonth = () => {
    if (currentMonth === 11) {
      setCurrentYear((y) => y + 1)
      setCurrentMonth(0)
    } else {
      setCurrentMonth((m) => m + 1)
    }
  }

  const goToToday = () => {
    const now = new Date()
    setCurrentYear(now.getFullYear())
    setCurrentMonth(now.getMonth())
    const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    updateActiveTab({ selectedCalendarDate: iso })
  }

  const handleDayClick = (day: number) => {
    const iso = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    updateActiveTab({ selectedCalendarDate: iso === selectedCalendarDate ? null : iso })
  }

  // Build grid: leading empty cells + day cells + trailing empty cells
  const cells: (number | null)[] = []
  for (let i = 0; i < firstDayOfWeek; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(d)
  while (cells.length % 7 !== 0) cells.push(null)

  // Localized short month names ("Jan".."Dec") for the month-picker grid.
  const monthShortNames = useMemo(() => {
    return Array.from({ length: 12 }, (_, m) =>
      new Date(2000, m, 1).toLocaleDateString(locale, { month: 'short' }),
    )
  }, [locale])

  // 12-year decade grid for the year picker.
  const yearGridValues = useMemo(
    () => Array.from({ length: 12 }, (_, i) => yearGridStart + i),
    [yearGridStart],
  )

  // Floating-ui — month picker popover
  const monthFloating = useFloating({
    open: monthPickerOpen,
    onOpenChange: (next) => {
      setMonthPickerOpen(next)
      if (next) setYearPickerOpen(false)
    },
    placement: 'bottom-start',
    whileElementsMounted: autoUpdate,
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
  })
  const monthClick = useClick(monthFloating.context)
  const monthDismiss = useDismiss(monthFloating.context)
  const monthRole = useRole(monthFloating.context, { role: 'dialog' })
  const monthInteractions = useInteractions([monthClick, monthDismiss, monthRole])

  // Floating-ui — year picker popover
  const yearFloating = useFloating({
    open: yearPickerOpen,
    onOpenChange: (next) => {
      setYearPickerOpen(next)
      if (next) {
        setMonthPickerOpen(false)
        // Snap the grid to the decade containing the current year.
        setYearGridStart(Math.floor(currentYear / 12) * 12)
      }
    },
    placement: 'bottom-start',
    whileElementsMounted: autoUpdate,
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
  })
  const yearClick = useClick(yearFloating.context)
  const yearDismiss = useDismiss(yearFloating.context)
  const yearRole = useRole(yearFloating.context, { role: 'dialog' })
  const yearInteractions = useInteractions([yearClick, yearDismiss, yearRole])

  const handlePickMonth = (m: number) => {
    setCurrentMonth(m)
    setMonthPickerOpen(false)
  }

  const handlePickYear = (y: number) => {
    setCurrentYear(y)
    setYearPickerOpen(false)
  }

  return (
    <SecondPanel className="">
      {/* Calendar column — grid + pickers. Entries for the selected day
          render in a separate panel below (same bg-panel-2 first-panel surface). */}
      <RestoredScroll
        view="calendar"
        className={cn(
          'flex flex-col gap-4 p-4',
          selectedCalendarDate ? 'shrink-0' : 'min-h-0 flex-1 overflow-y-auto',
        )}
      >
        {/* Header — month/year heading (each clickable) + nav */}
        <div className="flex items-center justify-between">
          <h2 className="font-title text-fg text-3xl leading-none font-semibold tracking-[-0.8px]">
            <button
              ref={monthFloating.refs.setReference}
              type="button"
              aria-label={t('calendar_panel.pick_month')}
              aria-haspopup="dialog"
              aria-expanded={monthPickerOpen}
              {...monthInteractions.getReferenceProps()}
              className="hover:text-accent rounded-md px-0.5 transition-colors duration-150 outline-none"
            >
              {currentMonth + 1}
            </button>
            <span className="text-fg-muted font-bold"> / </span>
            <button
              ref={yearFloating.refs.setReference}
              type="button"
              aria-label={t('calendar_panel.pick_year')}
              aria-haspopup="dialog"
              aria-expanded={yearPickerOpen}
              {...yearInteractions.getReferenceProps()}
              className="text-fg-muted hover:text-accent rounded-md px-0.5 font-bold transition-colors duration-150 outline-none"
            >
              {currentYear}
            </button>
          </h2>
          <div className="flex items-center gap-2">
            <IconButton aria-label={t('calendar_panel.prev_month')} onClick={prevMonth}>
              <ChevronLeft className="size-4" />
            </IconButton>
            <IconButton aria-label={t('calendar_panel.next_month')} onClick={nextMonth}>
              <ChevronRight className="size-4" />
            </IconButton>
            <Button size="sm" onClick={goToToday}>
              {t('calendar_panel.today')}
            </Button>
          </div>
        </div>

        {/* Month picker popover */}
        {monthPickerOpen && (
          <FloatingPortal>
            <div
              ref={monthFloating.refs.setFloating}
              style={monthFloating.floatingStyles}
              {...monthInteractions.getFloatingProps()}
              className="z-50"
            >
              <div className="border-border-default bg-elevated rounded-2xl border p-2 shadow-(--elev-4)">
                <div className="grid grid-cols-3 gap-1">
                  {monthShortNames.map((name, m) => {
                    const isSelected = m === currentMonth
                    return (
                      <button
                        key={m}
                        type="button"
                        onClick={() => handlePickMonth(m)}
                        className={cn(
                          'min-w-16 rounded-[10px] px-3 py-2 text-sm font-medium capitalize transition-colors duration-(--motion-duration-fast)',
                          isSelected
                            ? 'gradient-primary text-fg-inverse font-medium'
                            : 'text-fg hover:bg-surface-hi',
                        )}
                      >
                        {name}
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          </FloatingPortal>
        )}

        {/* Year picker popover — 12-year decade grid with ◀ ▶ */}
        {yearPickerOpen && (
          <FloatingPortal>
            <div
              ref={yearFloating.refs.setFloating}
              style={yearFloating.floatingStyles}
              {...yearInteractions.getFloatingProps()}
              className="z-50"
            >
              <div className="border-border-default bg-elevated rounded-2xl border p-2 shadow-(--elev-4)">
                <div className="mb-2 flex items-center justify-between gap-2 px-1">
                  <IconButton
                    aria-label={t('calendar_panel.prev_decade')}
                    onClick={() => setYearGridStart((s) => s - 12)}
                  >
                    <ChevronLeft className="size-4" />
                  </IconButton>
                  <span className="text-fg-muted text-xs font-bold tracking-[0.6px] uppercase">
                    {yearGridStart} – {yearGridStart + 11}
                  </span>
                  <IconButton
                    aria-label={t('calendar_panel.next_decade')}
                    onClick={() => setYearGridStart((s) => s + 12)}
                  >
                    <ChevronRight className="size-4" />
                  </IconButton>
                </div>
                <div className="grid grid-cols-3 gap-1">
                  {yearGridValues.map((y) => {
                    const isSelected = y === currentYear
                    const isToday = y === Number(todayISO.slice(0, 4))
                    return (
                      <button
                        key={y}
                        type="button"
                        onClick={() => handlePickYear(y)}
                        className={cn(
                          'min-w-16 rounded-[10px] px-3 py-2 text-sm font-medium tabular-nums transition-colors duration-(--motion-duration-fast)',
                          isSelected
                            ? 'gradient-primary text-fg-inverse font-medium'
                            : isToday
                              ? 'bg-accent-soft text-accent-text font-medium'
                              : 'text-fg hover:bg-surface-hi',
                        )}
                      >
                        {y}
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          </FloatingPortal>
        )}

        {/* SuperX featured month shell — gradient frame around the day grid */}
        <div className="card-glow">
          <div className="card-glow-inner p-3">
            {/* Weekday headers */}
            <div className="mb-1 grid grid-cols-7 text-center">
              {WEEKDAY_KEYS.map((k) => (
                <div key={k} className="text-fg-faint py-1 font-mono text-xs">
                  {t(`calendar_panel.weekday.${k}`)}
                </div>
              ))}
            </div>

            {/* Day grid */}
            <div className="grid grid-cols-7 gap-1">
              {cells.map((day, i) => {
                if (!day)
                  return (
                    <div
                      key={`empty-${i}`}
                      aria-hidden="true"
                      className="aspect-square rounded-xl border border-transparent"
                    />
                  )
                const iso = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
                const hasEntries = daysWithEntries.has(iso)
                const isSelected = selectedCalendarDate === iso
                const isToday = todayISO === iso
                // Defensive dedupe — the day cell must show at most one dot
                // per DISTINCT emotion (max 3, one for bad/neutral/good).
                // The backend already dedupes per (date, emotion), but if a
                // future schema drift or stale-data path leaks duplicates,
                // a naive `slice(0, 3)` could drop a unique emotion in
                // favour of repeats. `new Set()` preserves insertion order
                // (= latest-first contract from the hook) while guaranteeing
                // uniqueness regardless of the input shape.
                const emotionKeys = Array.from(new Set(emotionByDate.get(iso) ?? []))
                const emotionLabels = emotionKeys
                  .map((k) => tEditor(EMOTION_BY_KEY[k].i18nKey))
                  .join(', ')

                return (
                  <button
                    key={day}
                    type="button"
                    aria-label={
                      emotionLabels
                        ? `${day} ${monthLabel} — ${emotionLabels}`
                        : `${day} ${monthLabel}`
                    }
                    onClick={() => handleDayClick(day)}
                    aria-pressed={isSelected}
                    className={cn(
                      // SuperX day cell: 12px radius, border-strong hairline
                      'xj-cal-day flex aspect-square flex-col items-center justify-between rounded-xl border pt-1.5 pb-1 text-sm',
                      'transition-[background-color,border-color] duration-(--motion-duration-fast) ease-(--motion-ease-out-expo)',
                      hasEntries ? 'text-fg font-medium' : 'text-fg-muted font-normal',
                      // selected > today > plain
                      isSelected
                        ? 'bg-accent-soft border-accent/70 hover:bg-accent-soft'
                        : isToday
                          ? 'border-accent/40 ring-accent/30 hover:bg-surface-hi ring-1'
                          : 'border-border-default hover:bg-surface-hi',
                    )}
                  >
                    <span>{day}</span>
                    {/* Bottom indicators — emotion dots when emotions are tagged;
                      a single accent dot when the day has entries but no tagged
                      emotion. This preserves the full emotion feature while
                      adding the required has-entry indicator from the redesign. */}
                    {emotionKeys.length > 0 ? (
                      <span aria-hidden data-emotion-dots className="flex items-center gap-0.5">
                        {emotionKeys.map((key) => {
                          const meta = EMOTION_BY_KEY[key]
                          return (
                            <span
                              key={key}
                              className="h-1 w-1 rounded-full"
                              style={{ backgroundColor: isDark ? meta.hueDark : meta.hue }}
                            />
                          )
                        })}
                      </span>
                    ) : hasEntries ? (
                      <span aria-hidden data-entry-dot className="bg-accent h-1 w-1 rounded-full" />
                    ) : (
                      // Empty spacer to keep consistent height for cells without dots
                      <span aria-hidden className="h-1" />
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      </RestoredScroll>

      {/* Entries panel — renders below the calendar grid when a day is
          selected. The surface stays bg-panel-2 like the rest of the first panel. */}
      {selectedCalendarDate && (
        <div className="min-h-0 flex-1">
          <div className="flex h-full flex-col gap-2 overflow-hidden">
            <AiSummaryTrigger.Root
              entries={selectedDateEntries.map((e) => ({
                id: e.id,
                title: e.title,
                content_text: e.content_text,
                entry_date: e.entry_date,
              }))}
            >
              <div className="flex min-h-0 flex-1 flex-col">
                <div
                  className={cn(
                    'relative z-20 flex h-12 shrink-0 items-center justify-between gap-2 border-b py-2 pr-2 pl-4',
                    'border-border-default',
                    isClean
                      ? 'bg-surface-hi'
                      : "before:from-accent/25 before:pointer-events-none before:absolute before:inset-0 before:bg-linear-to-r before:to-transparent before:content-['']",
                  )}
                >
                  <div className="relative z-10 flex min-w-0 items-baseline gap-2">
                    <span className="text-fg-faint text-2xs truncate font-mono font-medium tracking-[0.8px] uppercase">
                      {new Date(selectedCalendarDate + 'T12:00:00').toLocaleDateString(locale, {
                        weekday: 'short',
                        month: 'short',
                        day: 'numeric',
                      })}
                    </span>
                  </div>
                  {selectedDateEntries.length > 0 && (
                    <AiSummaryTrigger.Button size="sm" className="relative z-10" />
                  )}
                </div>
                <AiSummaryTrigger.Banner />
                {/* Scroll region — only the entry list scrolls; the date
                    header above stays fixed so its scrollbar never overlaps. */}
                <RestoredScroll
                  view="calendar"
                  sub="day"
                  ready={!dateEntriesLoading}
                  className="flex min-h-0 flex-1 flex-col overflow-y-auto"
                >
                  {selectedDateEntries.length === 0 ? (
                    <div className="flex flex-1 items-center justify-center">
                      <p className="text-fg-muted text-center text-sm">
                        {t(
                          activeJournalId === null
                            ? 'calendar_panel.no_entries'
                            : 'calendar_panel.no_entries_for_journal',
                        )}
                      </p>
                    </div>
                  ) : (
                    selectedDateEntries.map((entry) => (
                      <EntryCard
                        key={entry.id}
                        entry={entry}
                        isSelected={selectedEntryId === entry.id}
                        onClick={() => {
                          updateActiveTab({ selectedEntryId: entry.id })
                        }}
                        journal={journalMap.get(entry.journal_id) ?? null}
                        tags={entryTags.get(entry.id) ?? EMPTY_TAGS}
                        idleBg={ENTRY_CARD_IDLE_BG}
                      />
                    ))
                  )}
                </RestoredScroll>
              </div>
            </AiSummaryTrigger.Root>
          </div>
        </div>
      )}
    </SecondPanel>
  )
}
