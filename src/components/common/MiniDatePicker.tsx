import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '../../lib/cn'
import { parseISODate, toISODate } from '../../lib/dates'
import { resolveFirstDayOfWeek } from '../../lib/firstDayOfWeek'
import { useUiStore } from '../../stores/uiStore'
import { Button } from './Button'

interface MiniDatePickerProps {
  /** Currently selected date as Unix seconds (UTC epoch). */
  value: number
  /** Called with a new Unix seconds timestamp.
   *
   *  - In **immediate mode** (default, when `onCancel` is NOT provided):
   *    fires on every pick — clicking a day, "Today", AM/PM toggle, or
   *    blurring hour/minute. Used by RangePill where each change should
   *    persist right away.
   *  - In **staged mode** (when `onCancel` IS provided): fires ONLY when
   *    the user clicks Apply. All intermediate edits accumulate in
   *    internal state. Used by the editor header so the user can preview
   *    the new date/time before committing. */
  onChange: (timestamp: number) => void
  /** Optional. When provided, called for hour/minute edits instead of
   *  `onChange` in immediate mode. Lets the parent persist the new
   *  timestamp WITHOUT closing the picker so the user can keep adjusting
   *  the time. Ignored in staged mode (the Apply button handles commit).
   *  If omitted, hour/minute edits in immediate mode fall back to
   *  `onChange`. */
  onTimeChange?: (timestamp: number) => void
  /** Optional. When provided, the picker switches to **staged mode**:
   *  edits stay local until the user clicks Apply (commits via
   *  `onChange`) or Cancel (discards, fires `onCancel`). Renders an
   *  Apply/Cancel row in the footer. */
  onCancel?: () => void
  /** Optional. When provided, renders an "Extract from media" action
   *  alongside the Today button. Click hands off to the parent which
   *  is expected to query EXIF dates from the entry's media and open a
   *  picker modal. The picker closes after the parent acknowledges. */
  onExtractFromMedia?: () => void
}

// Indexed by `Date.getDay()` semantics (0 = Sunday … 6 = Saturday).
const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

function startOfMonth(year: number, month: number): Date {
  return new Date(year, month, 1)
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/**
 * Mini calendar grid for picking an entry date. Stateless w.r.t. the
 * selection — the parent owns the value. The view month is local state
 * so navigating prev/next doesn't bubble until the user actually picks
 * a day. The new timestamp preserves the original time-of-day so we
 * don't silently shift entries to midnight when only the calendar day
 * changes.
 */
export function MiniDatePicker({
  value,
  onChange,
  onTimeChange,
  onCancel,
  onExtractFromMedia,
}: MiniDatePickerProps) {
  const { t, i18n } = useTranslation('common')
  const timeFormat = useUiStore((s) => s.timeFormat)
  const is12h = timeFormat === '12h'

  // Staged mode: changes accumulate in `pendingValue` until Apply is
  // clicked. We only reset `pendingValue` from `value` when the user
  // hasn't started editing yet (pendingValue still tracks the last-seen
  // external value) — that way an external mutation (e.g. an EXIF
  // refetch landing on `entry_date`) doesn't silently wipe a draft the
  // user is in the middle of composing. On the first external change
  // after the user has edited, the new `value` is recorded but
  // `pendingValue` is left alone; the next mount cycle will pick up
  // the fresh `value` via the `useState` initializer.
  const staged = onCancel !== undefined
  const [pendingValue, setPendingValue] = useState<number>(value)
  const lastSeenValueRef = useRef<number>(value)
  useEffect(() => {
    if (pendingValue === lastSeenValueRef.current) {
      setPendingValue(value)
    }
    lastSeenValueRef.current = value
    // We intentionally omit `pendingValue` from deps: this effect runs
    // when `value` changes, and reads the current `pendingValue` via
    // the closure — including it would re-fire on every staged edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
  const effectiveValue = staged ? pendingValue : value

  const selectedDate = useMemo(() => new Date(effectiveValue * 1000), [effectiveValue])
  const today = useMemo(() => new Date(), [])

  const [viewYear, setViewYear] = useState(selectedDate.getFullYear())
  const [viewMonth, setViewMonth] = useState(selectedDate.getMonth())

  // Sync the view month when the parent passes a new `value` — keeps
  // the picker on the right month if it stays mounted across selections
  // (the picker is currently torn down between opens, but this future-
  // proofs the contract).
  useEffect(() => {
    setViewYear(selectedDate.getFullYear())
    setViewMonth(selectedDate.getMonth())
  }, [selectedDate])

  const firstDow = useMemo(() => resolveFirstDayOfWeek(i18n.language), [i18n.language])

  // Weekday header ordered according to the locale's first day. The
  // grid logic below uses the same rotation so cells line up.
  const orderedWeekdayKeys = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => WEEKDAY_KEYS[(firstDow + i) % 7])
  }, [firstDow])

  const monthLabel = useMemo(() => {
    const d = startOfMonth(viewYear, viewMonth)
    return d.toLocaleDateString(i18n.language, { month: 'long', year: 'numeric' })
  }, [viewYear, viewMonth, i18n.language])

  const grid = useMemo(() => {
    // Leading padding = how many cells of the previous month show up
    // before day 1 in the locale's week ordering.
    const monthFirstDow = startOfMonth(viewYear, viewMonth).getDay()
    const leading = (monthFirstDow - firstDow + 7) % 7
    const total = daysInMonth(viewYear, viewMonth)
    const cells: (number | null)[] = []
    for (let i = 0; i < leading; i++) cells.push(null)
    for (let d = 1; d <= total; d++) cells.push(d)
    while (cells.length % 7 !== 0) cells.push(null)
    return cells
  }, [viewYear, viewMonth, firstDow])

  function goPrev() {
    if (viewMonth === 0) {
      setViewMonth(11)
      setViewYear((y) => y - 1)
    } else {
      setViewMonth((m) => m - 1)
    }
  }

  function goNext() {
    if (viewMonth === 11) {
      setViewMonth(0)
      setViewYear((y) => y + 1)
    } else {
      setViewMonth((m) => m + 1)
    }
  }

  const hours24 = selectedDate.getHours()
  const minutes = selectedDate.getMinutes()
  const isPm = hours24 >= 12
  const displayHour = is12h ? ((hours24 + 11) % 12) + 1 : hours24
  const pad2 = (n: number) => n.toString().padStart(2, '0')

  // Local draft strings let the user freely type, backspace, and edit
  // intermediate values like "" or "1" without the controlled
  // `value={pad2(...)}` snapping the field back. We commit on blur
  // (and on Enter) and sync the draft back to the canonical value
  // whenever `value` changes externally (e.g. picking a day).
  const [hourDraft, setHourDraft] = useState<string>(pad2(displayHour))
  const [minuteDraft, setMinuteDraft] = useState<string>(pad2(minutes))
  const [dateDraft, setDateDraft] = useState<string>(() => toISODate(effectiveValue))

  useEffect(() => {
    setHourDraft(pad2(displayHour))
    setMinuteDraft(pad2(minutes))
    setDateDraft(toISODate(effectiveValue))
    // pad2 is referentially stable (defined in this scope) — depending
    // on the canonical values is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayHour, minutes, effectiveValue])

  const isNumeric = (s: string) => /^\d+$/.test(s)

  // Returns the validated h24 the draft would commit to (or current
  // `hours24` if the draft is invalid / unchanged). Lets us flush both
  // drafts atomically when Apply is clicked.
  const resolveHourDraft = (): number => {
    if (!isNumeric(hourDraft)) return hours24
    const n = parseInt(hourDraft, 10)
    if (is12h) {
      const clamped = Math.min(12, Math.max(1, n))
      return (clamped % 12) + (isPm ? 12 : 0)
    }
    return Math.min(23, Math.max(0, n))
  }

  const resolveMinuteDraft = (): number => {
    if (!isNumeric(minuteDraft)) return minutes
    const n = parseInt(minuteDraft, 10)
    return Math.min(59, Math.max(0, n))
  }

  const formatISODateParts = (year: number, month: number, day: number): string =>
    `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`

  const resolveDateDraft = (): { year: number; month: number; day: number } => {
    const parsed = parseISODate(dateDraft)
    if (parsed) return parsed
    return {
      year: selectedDate.getFullYear(),
      month: selectedDate.getMonth() + 1,
      day: selectedDate.getDate(),
    }
  }

  const commitDateDraft = () => {
    const parsed = parseISODate(dateDraft)
    const currentIso = toISODate(effectiveValue)
    if (!parsed) {
      setDateDraft(currentIso)
      return
    }
    const nextIso = formatISODateParts(parsed.year, parsed.month, parsed.day)
    if (nextIso === currentIso) {
      setDateDraft(currentIso)
      return
    }
    const next = new Date(
      parsed.year,
      parsed.month - 1,
      parsed.day,
      effectiveHours(),
      effectiveMinutes(),
      selectedDate.getSeconds(),
      selectedDate.getMilliseconds(),
    )
    setViewYear(parsed.year)
    setViewMonth(parsed.month - 1)
    applyChange(Math.floor(next.getTime() / 1000), 'date')
    setDateDraft(nextIso)
  }

  // The effective hour/minute used as the base for date-changing
  // actions (`pickDay`, `pickToday`, `toggleAmPm`). Reading the
  // resolved drafts means an un-blurred hour/minute is preserved
  // when the user clicks a calendar cell or flips AM/PM — without
  // this, the typed value would be silently discarded.
  const effectiveHours = () => resolveHourDraft()
  const effectiveMinutes = () => resolveMinuteDraft()

  // Route a timestamp change. In staged mode we only update the
  // internal pending state — `onChange` fires later when Apply is
  // clicked. In immediate mode we forward to the parent right away,
  // routing time-only edits through `onTimeChange` when available
  // (lets the editor patch in place without closing the popover).
  const applyChange = (ts: number, kind: 'date' | 'time') => {
    if (staged) {
      setPendingValue(ts)
      return
    }
    if (kind === 'time' && onTimeChange) onTimeChange(ts)
    else onChange(ts)
  }

  function pickDay(day: number) {
    const next = new Date(
      viewYear,
      viewMonth,
      day,
      effectiveHours(),
      effectiveMinutes(),
      selectedDate.getSeconds(),
      selectedDate.getMilliseconds(),
    )
    applyChange(Math.floor(next.getTime() / 1000), 'date')
  }

  function pickToday() {
    const now = new Date()
    const next = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      effectiveHours(),
      effectiveMinutes(),
      selectedDate.getSeconds(),
      selectedDate.getMilliseconds(),
    )
    applyChange(Math.floor(next.getTime() / 1000), 'date')
  }

  // Rebuild the timestamp from the currently selected date so changing
  // the time never silently shifts the day.
  const commitTime = (hours24Arg: number, minutesArg: number) => {
    const next = new Date(
      selectedDate.getFullYear(),
      selectedDate.getMonth(),
      selectedDate.getDate(),
      hours24Arg,
      minutesArg,
      selectedDate.getSeconds(),
      selectedDate.getMilliseconds(),
    )
    applyChange(Math.floor(next.getTime() / 1000), 'time')
  }

  const commitHourDraft = () => {
    const h24 = resolveHourDraft()
    if (h24 === hours24) {
      setHourDraft(pad2(displayHour))
      return
    }
    commitTime(h24, minutes)
  }

  const commitMinuteDraft = () => {
    const m = resolveMinuteDraft()
    if (m === minutes) {
      setMinuteDraft(pad2(minutes))
      return
    }
    commitTime(hours24, m)
  }

  const toggleAmPm = () => {
    // Flip the typed (not canonical) hour so an un-blurred draft is
    // preserved across the toggle. The post-commit sync effect then
    // resets the draft to the new canonical value.
    const h = (effectiveHours() + 12) % 24
    commitTime(h, effectiveMinutes())
  }

  // Build the would-be timestamp from `selectedDate` plus the current
  // draft inputs. Used by the Apply button so an un-blurred hour/minute
  // draft still gets committed. Returns `pendingValue` unchanged when
  // drafts already match the canonical h:m.
  const buildPendingWithDrafts = (): number => {
    const { year, month, day } = resolveDateDraft()
    const h24 = resolveHourDraft()
    const m = resolveMinuteDraft()
    const next = new Date(
      year,
      month - 1,
      day,
      h24,
      m,
      selectedDate.getSeconds(),
      selectedDate.getMilliseconds(),
    )
    return Math.floor(next.getTime() / 1000)
  }

  const handleApply = () => {
    const ts = buildPendingWithDrafts()
    onChange(ts)
  }

  const handleCancel = () => {
    // Reset staged state synchronously so the contract holds even if
    // a future refactor keeps the picker mounted across cancels (today
    // the parent unmounts the popover, which already discards state).
    setPendingValue(value)
    const baseDate = new Date(value * 1000)
    const baseHours = baseDate.getHours()
    const baseMinutes = baseDate.getMinutes()
    const baseDisplayHour = is12h ? ((baseHours + 11) % 12) + 1 : baseHours
    setHourDraft(pad2(baseDisplayHour))
    setMinuteDraft(pad2(baseMinutes))
    setDateDraft(toISODate(value))
    onCancel?.()
  }

  // Disable Apply only when the popover is in its initial unchanged
  // state — both the pending value and any un-blurred drafts must
  // match `value`. Avoids the surprise where the user types a new
  // hour, clicks Apply (without blurring first), and nothing happens.
  const applyDisabled = staged && buildPendingWithDrafts() === value

  return (
    <div className="w-65 select-none">
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          onClick={goPrev}
          aria-label={t('mini_date_picker.prev_month', { defaultValue: 'Previous month' })}
          className="text-fg-muted hover:bg-surface-subtle hover:text-fg flex size-7 items-center justify-center rounded-md transition-colors"
        >
          <ChevronLeft className="size-4" strokeWidth={1.75} />
        </button>
        <span className="text-fg text-sm font-semibold capitalize">{monthLabel}</span>
        <button
          type="button"
          onClick={goNext}
          aria-label={t('mini_date_picker.next_month', { defaultValue: 'Next month' })}
          className="text-fg-muted hover:bg-surface-subtle hover:text-fg flex size-7 items-center justify-center rounded-md transition-colors"
        >
          <ChevronRight className="size-4" strokeWidth={1.75} />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-0.5">
        {orderedWeekdayKeys.map((k) => (
          <div
            key={k}
            className="text-fg-muted text-2xs flex h-7 items-center justify-center font-medium tracking-wide uppercase"
          >
            {t(`mini_date_picker.weekday_short.${k}`, {
              defaultValue: k.charAt(0).toUpperCase() + k.charAt(1),
            })}
          </div>
        ))}
        {grid.map((day, i) => {
          if (day === null) {
            return <div key={`pad-${i}`} className="h-8" />
          }
          const cellDate = new Date(viewYear, viewMonth, day)
          const isSelected = sameLocalDay(cellDate, selectedDate)
          const isToday = sameLocalDay(cellDate, today)
          return (
            <button
              key={day}
              type="button"
              onClick={() => pickDay(day)}
              className={cn(
                'xj-cal-day flex h-8 items-center justify-center rounded-md text-xs font-medium transition-colors',
                isSelected
                  ? 'gradient-primary text-fg-inverse'
                  : isToday
                    ? 'text-accent hover:bg-accent-soft'
                    : 'text-fg hover:bg-surface-subtle',
              )}
              aria-pressed={isSelected}
              aria-label={cellDate.toLocaleDateString(i18n.language, {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
                year: 'numeric',
              })}
            >
              {day}
            </button>
          )
        })}
      </div>

      <div className="mt-2">
        <input
          type="text"
          inputMode="numeric"
          value={dateDraft}
          onChange={(e) => setDateDraft(e.target.value)}
          onBlur={commitDateDraft}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              ;(e.target as HTMLInputElement).blur()
            }
          }}
          onFocus={(e) => e.currentTarget.select()}
          placeholder="YYYY-MM-DD"
          aria-label={t('mini_date_picker.date_input', { defaultValue: 'Date' })}
          className="xj-input-bare border-border-default text-fg focus:border-accent placeholder:text-fg-muted w-full rounded-md border bg-transparent px-2 py-1 text-center text-xs font-medium tabular-nums transition-colors outline-none"
        />
      </div>

      {/* Time row — hour/minute editing, locale-aware 12h/24h. */}
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-fg-muted text-2xs font-medium tracking-wide uppercase">
          {t('mini_date_picker.time', { defaultValue: 'Time' })}
        </span>
        <div className="flex items-center gap-1">
          <input
            type="text"
            inputMode="numeric"
            pattern="\d*"
            maxLength={2}
            value={hourDraft}
            onChange={(e) => setHourDraft(e.target.value)}
            onBlur={commitHourDraft}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                ;(e.target as HTMLInputElement).blur()
              }
            }}
            onFocus={(e) => e.currentTarget.select()}
            aria-label={t('mini_date_picker.hour', { defaultValue: 'Hour' })}
            className="xj-input-bare border-border-default text-fg focus:border-accent w-11 rounded-md border bg-transparent px-1 py-0.5 text-center text-xs font-medium tabular-nums transition-colors outline-none"
          />
          <span className="text-fg-muted text-xs font-medium">:</span>
          <input
            type="text"
            inputMode="numeric"
            pattern="\d*"
            maxLength={2}
            value={minuteDraft}
            onChange={(e) => setMinuteDraft(e.target.value)}
            onBlur={commitMinuteDraft}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                ;(e.target as HTMLInputElement).blur()
              }
            }}
            onFocus={(e) => e.currentTarget.select()}
            aria-label={t('mini_date_picker.minute', { defaultValue: 'Minute' })}
            className="xj-input-bare border-border-default text-fg focus:border-accent w-11 rounded-md border bg-transparent px-1 py-0.5 text-center text-xs font-medium tabular-nums transition-colors outline-none"
          />
          {is12h && (
            <button
              type="button"
              onClick={toggleAmPm}
              aria-label={t('mini_date_picker.toggle_am_pm', {
                defaultValue: 'Toggle AM/PM',
              })}
              className="border-border-default text-fg hover:bg-surface-subtle text-2xs rounded-md border px-1.5 py-0.5 font-semibold tabular-nums transition-colors"
            >
              {isPm ? 'PM' : 'AM'}
            </button>
          )}
        </div>
      </div>

      <div className="mt-2 flex items-center justify-end gap-1">
        {onExtractFromMedia && (
          <button
            type="button"
            onClick={onExtractFromMedia}
            className="text-accent hover:bg-accent-soft text-2xs rounded-md px-2 py-1 font-medium transition-colors"
          >
            {t('mini_date_picker.extract_from_media', {
              defaultValue: 'Extract from media',
            })}
          </button>
        )}
        <button
          type="button"
          onClick={pickToday}
          className="text-accent hover:bg-accent-soft text-2xs rounded-md px-2 py-1 font-medium transition-colors"
        >
          {t('mini_date_picker.today', { defaultValue: 'Today' })}
        </button>
      </div>

      {staged && (
        <div className="border-border-default mt-2 flex items-center justify-end gap-2 border-t pt-2">
          <button
            type="button"
            onClick={handleCancel}
            className="text-fg-secondary hover:bg-surface-subtle rounded-md px-3 py-1 text-xs font-medium transition-colors"
          >
            {t('mini_date_picker.cancel', { defaultValue: 'Cancel' })}
          </button>
          <Button variant="primary" size="sm" onClick={handleApply} disabled={applyDisabled}>
            {t('mini_date_picker.apply', { defaultValue: 'Apply' })}
          </Button>
        </div>
      )}
    </div>
  )
}
