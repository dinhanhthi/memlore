import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingNode,
  FloatingPortal,
  FloatingTree,
  offset,
  shift,
  useDismiss,
  useFloating,
  useFloatingNodeId,
  useInteractions,
  useRole,
} from '@floating-ui/react'
import { Check, FileText } from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAttachableEntries } from '../../hooks/useAttachableEntries'
import { cn } from '../../lib/cn'
import { toggleEntrySelection } from '../../lib/chatEntrySelection'
import { formatDateRange, formatFriendlyRelativeTime, toISODate } from '../../lib/dates'
import { timeRangeBounds, type TimeRange } from '../../lib/entryFilterSort'
import { resolveFirstDayOfWeek } from '../../lib/firstDayOfWeek'
import { chatCountEntriesInRange } from '../../lib/tauri'
import type { ChatAttachment } from '../../types/ai'
import { Button } from '../common/Button'
import { Callout } from '../common/Callout'
import { MiniDatePicker } from '../common/MiniDatePicker'
import { RadioOptionPill } from '../common/RadioOptionPill'
import { SegmentedControl } from '../common/SegmentedControl'
import { TextInput } from '../common/TextInput'

type TFn = ReturnType<typeof useTranslation<['ai', 'editor']>>['t']
type EntryAttachment = Extract<ChatAttachment, { kind: 'entry' }>

// Backend abuse ceiling — mirrors `MAX_CHAT_ATTACHMENTS` in
// `src-tauri/src/db/queries.rs`, which rejects a 21st attachment on both the
// write and sync-ingest paths. This is a ceiling on peer-synced data, NOT a
// product choice, so it must stay at 20 even though the UI cap below is much
// stricter — lowering it here would reject legitimately-synced older rows
// that predate the stricter UI limit.
const MAX_CHAT_ATTACHMENTS = 20

// Product-facing cap, enforced purely in the UI: once selection would reach
// this many entries, further unselected rows become non-selectable (already-
// selected rows stay clickable so the user can still deselect). Deliberately
// much stricter than `MAX_CHAT_ATTACHMENTS` above — do NOT "reconcile" the
// two numbers, they answer different questions (product limit vs. sync-abuse
// ceiling).
const MAX_UI_CHAT_ATTACHMENTS = 5

// Ties the two constants together without conflating them: fails fast at
// module load if the UI cap is ever raised above the backend's hard ceiling
// (e.g. by someone "reconciling" the two numbers into one).
if (MAX_UI_CHAT_ATTACHMENTS > MAX_CHAT_ATTACHMENTS) {
  throw new Error('MAX_UI_CHAT_ATTACHMENTS must not exceed MAX_CHAT_ATTACHMENTS')
}

type PopoverTab = 'entries' | 'date'
type DatePreset = 'thisWeek' | 'thisMonth' | 'thisYear' | 'custom'

function todayNoonSec(): number {
  const d = new Date()
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0).getTime() / 1000)
}

// ─── Entries tab ─────────────────────────────────────────────────────────────

interface EntriesTabProps {
  t: TFn
  locale: string
  /** Entries currently selected for this turn (already-attached ones seeded
   *  by the caller, plus whatever the user has toggled on/off since). */
  selected: EntryAttachment[]
  /** True once selecting one more entry would exceed the UI cap — disables
   *  every row NOT already selected, while selected rows stay togglable. */
  atCap: boolean
  capBannerId: string
  onToggle: (entry: EntryAttachment) => void
}

/**
 * Results list is a `flex-1 min-h-0 overflow-y-auto` block on top; the
 * search box sits below it, outside the scroll container, so it never
 * scrolls away and its screen position stays put as the result count
 * (and therefore the list's height) changes while the user types.
 */
function EntriesTab({ t, locale, selected, atCap, capBannerId, onToggle }: EntriesTabProps) {
  const [query, setQuery] = useState('')
  const { entries, loading } = useAttachableEntries(query)
  const [activeIndex, setActiveIndex] = useState<number>(-1)
  // Reset the highlighted row whenever a new result set arrives. Adjusted
  // during render (not in an effect) per the React-recommended pattern for
  // syncing state to a changed value — `entries` gets a fresh array
  // reference from `useAttachableEntries` on every successful fetch.
  const [entriesForActiveIndex, setEntriesForActiveIndex] = useState(entries)
  if (entries !== entriesForActiveIndex) {
    setEntriesForActiveIndex(entries)
    setActiveIndex(entries.length > 0 ? 0 : -1)
  }
  const inputRef = useRef<HTMLInputElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const listboxId = useId()
  const optionId = (idx: number) => `${listboxId}-option-${idx}`

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true })
  }, [])

  // Arrow-key highlighting only moves `activeIndex` — it never moves real
  // DOM focus (that stays on the search input, per the combobox pattern),
  // so the browser's native focus-follows-scroll never kicks in. Without
  // this, arrowing past the visible rows highlights an option scrolled
  // out of view with no visual feedback.
  useEffect(() => {
    if (activeIndex < 0) return
    optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  function isSelected(id: string): boolean {
    return selected.some((a) => a.id === id)
  }

  function toggle(idx: number) {
    const entry = entries[idx]
    if (!entry) return
    if (!isSelected(entry.id) && atCap) return
    onToggle({ kind: 'entry', id: entry.id, title: entry.title, entryDate: entry.entryDate })
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (entries.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((prev) => (prev + 1) % entries.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((prev) => (prev <= 0 ? entries.length - 1 : prev - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (activeIndex >= 0) toggle(activeIndex)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <ul
        id={listboxId}
        role="listbox"
        aria-multiselectable="true"
        aria-label={t('daily_chat.attach_tab_entries', { defaultValue: 'Entries' })}
        className="max-h-60 min-h-0 flex-1 overflow-y-auto"
      >
        {entries.length === 0 && (
          <li role="presentation" className="text-fg-muted px-2 py-3 text-center text-xs">
            {loading
              ? t('daily_chat.attach_searching', { defaultValue: 'Searching…' })
              : t('daily_chat.attach_no_results', { defaultValue: 'No entries found' })}
          </li>
        )}
        {entries.map((entry, idx) => {
          const title = entry.title ?? t('editor:untitled_entry', { defaultValue: 'Untitled' })
          const active = idx === activeIndex
          const rowSelected = isSelected(entry.id)
          const rowDisabled = atCap && !rowSelected
          return (
            <li key={entry.id} role="presentation">
              <button
                ref={(node) => {
                  optionRefs.current[idx] = node
                }}
                id={optionId(idx)}
                role="option"
                tabIndex={-1}
                aria-selected={rowSelected}
                aria-disabled={rowDisabled}
                aria-describedby={rowDisabled ? capBannerId : undefined}
                type="button"
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => toggle(idx)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors',
                  rowDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
                  active && 'bg-accent-soft',
                  !active && !rowDisabled && 'hover:bg-panel-2',
                )}
              >
                {rowSelected ? (
                  <Check className="text-accent size-3.5 shrink-0" aria-hidden />
                ) : (
                  <FileText className="text-fg-muted size-3.5 shrink-0" aria-hidden />
                )}
                <span className="text-fg flex-1 truncate text-sm">{title}</span>
                <span className="text-fg-muted shrink-0 text-xs">
                  {formatFriendlyRelativeTime(entry.entryDate, locale)}
                </span>
              </button>
            </li>
          )
        })}
      </ul>

      <TextInput
        ref={inputRef}
        role="combobox"
        value={query}
        onChange={setQuery}
        onKeyDown={handleKeyDown}
        placeholder={t('daily_chat.attach_search_placeholder', { defaultValue: 'Search entries…' })}
        aria-label={t('daily_chat.attach_search_aria', { defaultValue: 'Search entries' })}
        aria-haspopup="listbox"
        aria-controls={entries.length > 0 ? listboxId : undefined}
        aria-expanded={entries.length > 0}
        aria-autocomplete="list"
        aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
        className="shrink-0 py-2 text-sm"
      />
    </div>
  )
}

// ─── Custom date range (secondary popover) ─────────────────────────────────

// Scaled down so two `w-65` `MiniDatePicker`s fit side by side inside a
// small secondary popover instead of stacking (which is what forced the
// original inline layout — a `w-80` main panel can't fit two at full size).
// 0.7 rather than 0.75 for a concrete layout reason, measured in the running
// app: at 0.75 the panel came out 399px wide, and placing it to the right of
// the 300px attach popover needed 795 + 8 + 399 = 1202px — overflowing a
// 1200px viewport by two pixels, which was enough for `flip` to bounce the
// whole thing over to the left. 0.7 brings it to ~372px so the intended
// right-hand placement actually survives at a normal window width; `flip`
// still catches genuinely narrow windows.
const CUSTOM_PICKER_SCALE = 0.7

/** Renders `children` at full size, measures their natural footprint, then
 *  visually shrinks them with a CSS `transform: scale()`. A `transform`
 *  never changes the element's layout box, so without an explicit wrapper
 *  sized to the scaled dimensions the shrunk content would leave a
 *  phantom-sized gap where its unscaled box used to be — this measures
 *  that box (via `ResizeObserver`, so it stays correct across locales/
 *  content changes) and pins the wrapper to the scaled equivalent. */
function ScaledPickerPair({ children }: { children: ReactNode }) {
  const innerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)

  useLayoutEffect(() => {
    const el = innerRef.current
    if (!el) return
    const measure = () => setSize({ width: el.scrollWidth, height: el.scrollHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div
      style={
        size
          ? {
              width: size.width * CUSTOM_PICKER_SCALE,
              height: size.height * CUSTOM_PICKER_SCALE,
            }
          : undefined
      }
    >
      <div
        ref={innerRef}
        style={{ transform: `scale(${CUSTOM_PICKER_SCALE})`, transformOrigin: 'top left' }}
        className="flex w-max gap-3"
      >
        {children}
      </div>
    </div>
  )
}

interface CustomDateRangePopoverProps {
  open: boolean
  onClose: () => void
  /** The "Custom" preset pill — where focus returns on Escape/close. */
  anchorRef: React.RefObject<HTMLElement | null>
  /** The MAIN attach popover's panel — what this popover is POSITIONED
   *  against. Deliberately not the pill: the pill sits inside the panel, so
   *  anchoring position to it puts `right-start` in the middle of the panel
   *  and the calendars cover the preset pills the user is still choosing
   *  between. Anchoring to the panel also lets `flip` actually fire, since
   *  only then does "no room on the right" become true overflow. */
  positionAnchorRef: React.RefObject<HTMLElement | null>
  fromSec: number
  toSec: number
  onFromChange: (sec: number) => void
  onToChange: (sec: number) => void
  t: TFn
}

/**
 * Small secondary popover anchored to the right of the "Custom" preset
 * pill, holding the From/To pickers side by side. Nested under the main
 * attach popover's `FloatingTree` so Escape / outside-press only ever
 * dismiss this inner popover, never the main one.
 */
function CustomDateRangePopover({
  open,
  onClose,
  anchorRef,
  positionAnchorRef,
  fromSec,
  toSec,
  onFromChange,
  onToChange,
  t,
}: CustomDateRangePopoverProps) {
  const nodeId = useFloatingNodeId()

  const { refs, floatingStyles, context } = useFloating({
    nodeId,
    open,
    onOpenChange: (nextOpen) => {
      if (!nextOpen) onClose()
    },
    placement: 'right-start',
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    // Right is the intended side, but this panel is ~400px wide next to a
    // 300px popover: on a 1200px viewport there is not enough room to its
    // right, and a bare `shift` answers that by sliding it back OVER the
    // attach popover — the two calendars then cover the preset pills the user
    // is still choosing between. `fallbackPlacements` makes it flip cleanly to
    // the left in that case instead, and `crossAxis: false` stops `shift` from
    // reintroducing the horizontal overlap after flip has already picked a
    // side that fits.
    middleware: [
      offset(8),
      flip({ padding: 8, fallbackPlacements: ['left-start', 'bottom-start'] }),
      shift({ padding: 8, crossAxis: false }),
    ],
  })

  useEffect(() => {
    refs.setReference(positionAnchorRef.current)
  }, [refs, positionAnchorRef, open])

  const dismiss = useDismiss(context)
  const role = useRole(context, { role: 'dialog' })
  const { getFloatingProps } = useInteractions([dismiss, role])

  if (!open) return null

  return (
    <FloatingNode id={nodeId}>
      <FloatingPortal>
        <FloatingFocusManager context={context} modal={false} returnFocus>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            {...getFloatingProps({
              onKeyDown: (e) => {
                if (e.key === 'Escape') {
                  // Stop this Escape from also reaching the main attach
                  // popover's own keydown handler — it would otherwise
                  // close the whole popover instead of just this one.
                  e.stopPropagation()
                  onClose()
                  anchorRef.current?.focus()
                }
              },
            })}
            aria-label={t('daily_chat.attach_custom_range_aria', {
              defaultValue: 'Custom date range',
            })}
            className="bg-elevated border-border-default z-50 rounded-xl border p-3 shadow-xl"
          >
            <ScaledPickerPair>
              <div className="flex flex-col gap-1.5">
                <span className="text-fg-muted text-xs font-medium">
                  {t('daily_chat.attach_custom_from', { defaultValue: 'From' })}
                </span>
                {/* `xj-chat-attach-custom-range` bumps only the day-number
                 *  font size inside this wrapper (see globals.css) — a
                 *  targeted descendant selector, NOT a change to
                 *  `MiniDatePicker` itself, which is shared by RangePill,
                 *  the editor header, and others. */}
                <div className="xj-chat-attach-custom-range">
                  <MiniDatePicker value={fromSec} onChange={onFromChange} />
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-fg-muted text-xs font-medium">
                  {t('daily_chat.attach_custom_to', { defaultValue: 'To' })}
                </span>
                <div className="xj-chat-attach-custom-range">
                  <MiniDatePicker value={toSec} onChange={onToChange} />
                </div>
              </div>
            </ScaledPickerPair>
          </div>
        </FloatingFocusManager>
      </FloatingPortal>
    </FloatingNode>
  )
}

// ─── Date tab ────────────────────────────────────────────────────────────────

interface DateTabProps {
  t: TFn
  preset: DatePreset
  onPresetChange: (preset: DatePreset) => void
  fromSec: number
  toSec: number
  onFromChange: (sec: number) => void
  onToChange: (sec: number) => void
  bounds: { from: number; toExclusive: number } | null
  label: string | null
  entryCount: number | null
  countLoading: boolean
  /** The main attach popover's panel, used to position the custom-range
   *  popover beside it rather than on top of it. */
  panelRef: React.RefObject<HTMLElement | null>
}

/**
 * Preset/custom-range picker with a pre-commit entry count. Purely
 * presentational w.r.t. the range itself — `preset`/`fromSec`/`toSec`/
 * `bounds`/`entryCount`/`countLoading` are all owned by the parent
 * (`ChatAttachPopoverInner`) because the shared Attach button (change 4)
 * needs to read them to decide its own disabled state and commit action.
 * Only the "Custom" secondary popover's open/closed flag stays local — it
 * never affects the Attach button.
 */
function DateTab({
  t,
  preset,
  onPresetChange,
  fromSec,
  toSec,
  onFromChange,
  onToChange,
  bounds,
  label,
  entryCount,
  countLoading,
  panelRef,
}: DateTabProps) {
  const [customPopoverOpen, setCustomPopoverOpen] = useState(false)
  const customPillRef = useRef<HTMLButtonElement>(null)

  const presetOptions: { value: DatePreset; label: string }[] = [
    {
      value: 'thisWeek',
      label: t('daily_chat.attach_preset_this_week', { defaultValue: 'This week' }),
    },
    {
      value: 'thisMonth',
      label: t('daily_chat.attach_preset_this_month', { defaultValue: 'This month' }),
    },
    {
      value: 'thisYear',
      label: t('daily_chat.attach_preset_this_year', { defaultValue: 'This year' }),
    },
    { value: 'custom', label: t('daily_chat.attach_preset_custom', { defaultValue: 'Custom' }) },
  ]

  // Selecting "Custom" (even when it's already selected) opens the
  // secondary date-range popover; any other preset closes it.
  function handlePresetClick(next: DatePreset) {
    onPresetChange(next)
    setCustomPopoverOpen(next === 'custom')
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        role="radiogroup"
        aria-label={t('daily_chat.attach_preset_aria', { defaultValue: 'Date range preset' })}
        className="flex flex-wrap items-center gap-2"
      >
        {presetOptions.map((opt) => (
          <RadioOptionPill
            key={opt.value}
            ref={opt.value === 'custom' ? customPillRef : undefined}
            selected={preset === opt.value}
            onClick={() => handlePresetClick(opt.value)}
            label={opt.label}
            className="h-6 px-3 text-xs"
          />
        ))}
      </div>

      <CustomDateRangePopover
        open={customPopoverOpen}
        onClose={() => setCustomPopoverOpen(false)}
        anchorRef={customPillRef}
        positionAnchorRef={panelRef}
        fromSec={fromSec}
        toSec={toSec}
        onFromChange={onFromChange}
        onToChange={onToChange}
        t={t}
      />

      {preset === 'custom' && !bounds && (
        <p className="text-danger-text text-xs">
          {t('daily_chat.attach_invalid_range', {
            defaultValue: 'End date must be on or after the start date.',
          })}
        </p>
      )}

      {bounds && (
        <div className="border-border-default bg-panel-1 flex items-center justify-between gap-2 rounded-lg border px-3 py-2">
          <span className="text-fg truncate text-sm font-medium">{label}</span>
          <span className="text-fg-muted shrink-0 text-xs">
            {countLoading
              ? t('daily_chat.attach_counting', { defaultValue: 'Counting…' })
              : entryCount !== null
                ? t('daily_chat.attach_entry_count', {
                    count: entryCount,
                    defaultValue: '{{count}} entries',
                  })
                : null}
          </span>
        </div>
      )}
    </div>
  )
}

// ─── Popover ─────────────────────────────────────────────────────────────────

export interface ChatAttachPopoverProps {
  open: boolean
  onClose: () => void
  /** The Attach button this popover is anchored to. Owned by the caller
   *  (`ChatConversation`, T5.8) — this component only reads it for
   *  positioning and for returning focus on Escape. */
  anchorRef: React.RefObject<HTMLElement | null>
  /** Id applied to the floating dialog element. Generated by the caller so
   *  the Attach button can point `aria-controls` at it without this
   *  component needing to hand a ref/id back up. */
  id: string
  /** Attachments already pinned to the current turn (both kinds). Read once
   *  at mount to seed the Entries tab's selection — so already-attached
   *  entries show as checked — and to compute the UI attachment cap. The
   *  popover fully unmounts on close (see `ChatAttachPopover` below), so a
   *  later reopen always seeds from the current value, never a stale one. */
  attachments: ChatAttachment[]
  /** Commits a single period (Date tab) attachment. */
  onSelect: (attachment: ChatAttachment) => void
  /** Commits the Entries tab's full current selection at once — the
   *  caller is expected to replace whatever entry-kind attachments existed
   *  before with this list, leaving period-kind attachments untouched. */
  onCommitEntries: (entries: EntryAttachment[]) => void
}

function ChatAttachPopoverInner({
  onClose,
  anchorRef,
  id,
  attachments,
  onSelect,
  onCommitEntries,
}: ChatAttachPopoverProps) {
  const { t, i18n } = useTranslation(['ai', 'editor'])
  const locale = i18n.language
  const [tab, setTab] = useState<PopoverTab>('entries')
  const capBannerId = useId()
  const nodeId = useFloatingNodeId()
  // The panel element itself — handed to the custom-range popover so it is
  // positioned beside this panel rather than beside the pill inside it.
  const panelRef = useRef<HTMLDivElement | null>(null)

  // ── Entries tab selection, owned here (not inside `EntriesTab`) so it
  //    survives switching to the Date tab and back within one opening. ──
  const entryAttachments = useMemo(
    () => attachments.filter((a): a is EntryAttachment => a.kind === 'entry'),
    [attachments],
  )
  const [selectedEntries, setSelectedEntries] = useState<EntryAttachment[]>(entryAttachments)

  function handleToggleEntry(entry: EntryAttachment) {
    setSelectedEntries((prev) => toggleEntrySelection(prev, entry, MAX_UI_CHAT_ATTACHMENTS))
  }

  // Real, already-committed count vs. the count if the Entries tab's
  // in-progress selection were committed right now — they only diverge once
  // the user starts toggling rows. The Date tab's commit gate uses the real
  // count (committing a period doesn't touch pending Entries edits); the
  // Entries tab's row-disable uses the prospective one; the banner shows for
  // either, so a reason is visible the moment rows start getting disabled.
  const committedAtCap = attachments.length >= MAX_UI_CHAT_ATTACHMENTS
  const entriesProspectiveCount =
    attachments.length - entryAttachments.length + selectedEntries.length
  const entriesAtCap = entriesProspectiveCount >= MAX_UI_CHAT_ATTACHMENTS
  // Per-tab, not a blanket OR: while the user is deselecting Entries-tab rows
  // back down from a previously-committed cap, `committedAtCap` stays true
  // (nothing has actually been un-committed yet) even though rows are
  // selectable again — showing the banner off that stale value would tell the
  // user they're capped while visibly letting them pick more.
  const showCapBanner = tab === 'entries' ? entriesAtCap : committedAtCap

  // ── Date tab state, lifted here so the shared Attach button below (T5.8
  //    change 4) can read its readiness and commit it directly — the Date
  //    tab no longer renders its own Attach button. ──
  const [preset, setPreset] = useState<DatePreset>('thisWeek')
  const [fromSec, setFromSec] = useState<number>(todayNoonSec)
  const [toSec, setToSec] = useState<number>(todayNoonSec)
  const [entryCount, setEntryCount] = useState<number | null>(null)
  const [countLoading, setCountLoading] = useState(false)

  const range: TimeRange = useMemo(() => {
    if (preset === 'custom') {
      return { kind: 'custom', fromDateIso: toISODate(fromSec), toDateIso: toISODate(toSec) }
    }
    return { kind: preset }
  }, [preset, fromSec, toSec])

  const firstDayOfWeek = useMemo(() => resolveFirstDayOfWeek(locale), [locale])
  const bounds = useMemo(() => timeRangeBounds(range, { firstDayOfWeek }), [range, firstDayOfWeek])
  // Hoisted to plain values — an optional-chain expression directly in a
  // useEffect dependency array is rejected by react-hooks/exhaustive-deps.
  const boundsFrom = bounds?.from ?? null
  const boundsToExclusive = bounds?.toExclusive ?? null
  const dateLabel = bounds ? formatDateRange(bounds.from, bounds.toExclusive, locale) : null

  useEffect(() => {
    // No bounds → nothing to count. `entryCount`/`countLoading` are only
    // ever read from JSX guarded by `bounds !== null`, so a stale value
    // from a previous valid range is never shown — no reset needed here.
    if (boundsFrom === null || boundsToExclusive === null) {
      return
    }
    let cancelled = false
    setCountLoading(true)
    const handle = setTimeout(() => {
      chatCountEntriesInRange(boundsFrom, boundsToExclusive)
        .then((result) => {
          if (cancelled) return
          setEntryCount(result.entryCount)
          setCountLoading(false)
        })
        .catch(() => {
          if (cancelled) return
          setEntryCount(null)
          setCountLoading(false)
        })
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [boundsFrom, boundsToExclusive])

  const dateCanCommit = !committedAtCap && bounds !== null && entryCount !== null && !countLoading
  // The button sits OUTSIDE both tabs, so the user reads it as "attach what I
  // picked" — not "attach the tab I happen to be looking at". Selected entries
  // must therefore survive a trip to the Date tab: select five, switch over to
  // add a range, press Attach, and losing the five silently is the worst
  // outcome this popover can produce.
  //
  // The period is deliberately NOT symmetric: the Date tab starts on a valid
  // default preset, so committing it whenever it happens to be valid would
  // attach a range the user never looked at every time they attach entries.
  // It commits only while that tab is the one on screen, where its range and
  // entry count are visible right above the button.
  const hasPendingEntries = selectedEntries.length > 0
  const willCommitPeriod = tab === 'date' && dateCanCommit
  const canCommit = hasPendingEntries || willCommitPeriod

  function handleCommit() {
    if (!canCommit) return
    if (hasPendingEntries) onCommitEntries(selectedEntries)
    if (willCommitPeriod && bounds && entryCount !== null) {
      onSelect({
        kind: 'period',
        start: bounds.from,
        end: bounds.toExclusive,
        label: dateLabel ?? '',
        entryCount,
      })
    }
    onClose()
  }

  const { refs, floatingStyles, context } = useFloating({
    nodeId,
    open: true,
    onOpenChange: (nextOpen) => {
      if (!nextOpen) onClose()
    },
    placement: 'top-start',
    whileElementsMounted: autoUpdate,
    middleware: [offset(8), flip(), shift({ padding: 8 })],
  })

  useEffect(() => {
    refs.setReference(anchorRef.current)
  }, [refs, anchorRef])

  const dismiss = useDismiss(context)
  const role = useRole(context, { role: 'dialog' })
  const { getFloatingProps } = useInteractions([dismiss, role])

  return (
    <FloatingNode id={nodeId}>
      <FloatingPortal>
        {/* `initialFocus={-1}` defers to EntriesTab's own focus effect on the
         *  search input instead of FFM's default first-tabbable-element jump.
         *  Modal (default) trapping is what actually contains Tab/Shift+Tab —
         *  RangePill's roving-tabindex doesn't fit here since this popover
         *  mixes a combobox+listbox tab with a plain-controls Date tab. */}
        <FloatingFocusManager context={context} initialFocus={-1}>
          <div
            ref={(node) => {
              refs.setFloating(node)
              panelRef.current = node
            }}
            id={id}
            style={floatingStyles}
            {...getFloatingProps({
              onKeyDown: (e) => {
                if (e.key === 'Escape') {
                  onClose()
                  anchorRef.current?.focus()
                }
              },
            })}
            aria-label={t('daily_chat.attach_dialog_aria', { defaultValue: 'Attach content' })}
            className="bg-elevated border-border-default z-50 flex w-80 flex-col gap-3 rounded-xl border p-3 shadow-xl"
          >
            {showCapBanner && (
              <Callout id={capBannerId} tone="warning" size="sm" className="shrink-0">
                {t('daily_chat.attach_cap_reached', {
                  max: MAX_UI_CHAT_ATTACHMENTS,
                  defaultValue: "You've reached the {{max}}-attachment limit for this message.",
                })}
              </Callout>
            )}

            {tab === 'entries' ? (
              <EntriesTab
                t={t}
                locale={locale}
                selected={selectedEntries}
                atCap={entriesAtCap}
                capBannerId={capBannerId}
                onToggle={handleToggleEntry}
              />
            ) : (
              <DateTab
                t={t}
                preset={preset}
                onPresetChange={setPreset}
                fromSec={fromSec}
                toSec={toSec}
                onFromChange={setFromSec}
                onToChange={setToSec}
                bounds={bounds}
                label={dateLabel}
                entryCount={entryCount}
                countLoading={countLoading}
                panelRef={panelRef}
              />
            )}

            {/* Pinned to the bottom, outside the Entries tab's scroll
             *  container, so it stays put while the result count (and
             *  therefore the list's height) changes as the user types.
             *  Tabs and the shared Attach button sit in one `justify-between`
             *  row — the button commits whichever tab is active. */}
            <div className="flex shrink-0 items-center justify-between gap-2">
              <SegmentedControl
                value={tab}
                onChange={setTab}
                options={[
                  {
                    value: 'entries',
                    label: t('daily_chat.attach_tab_entries', { defaultValue: 'Entries' }),
                  },
                  {
                    value: 'date',
                    label: t('daily_chat.attach_tab_date', { defaultValue: 'Date' }),
                  },
                ]}
                ariaLabel={t('daily_chat.attach_tab_aria', { defaultValue: 'Attachment type' })}
              />
              <Button
                variant="primary"
                size="sm"
                onClick={handleCommit}
                disabled={!canCommit}
                aria-describedby={showCapBanner ? capBannerId : undefined}
              >
                {t('daily_chat.attach_confirm', { defaultValue: 'Attach' })}
              </Button>
            </div>
          </div>
        </FloatingFocusManager>
      </FloatingPortal>
    </FloatingNode>
  )
}

/**
 * Two-tab picker for pinning journal content to a Daily Chat turn —
 * Entries (multi-select + search) and Date (preset/custom range with a
 * pre-commit entry count). Anchored to the caller's Attach button via
 * `anchorRef`, following `RangePill.tsx`'s floating-ui setup.
 *
 * Fully unmounts while `open` is false (rather than rendering `null` from
 * within `ChatAttachPopoverInner`) so every opening starts from fresh state —
 * required for the Entries tab to correctly re-seed its selection from the
 * caller's current `attachments` on each open, not just the first one.
 *
 * Wrapped in `FloatingTree` so the Date tab's secondary custom-range
 * popover (nested inside this one) can dismiss independently — its own
 * Escape/outside-press only ever closes itself, never this outer popover.
 */
export function ChatAttachPopover(props: ChatAttachPopoverProps) {
  if (!props.open) return null
  return (
    <FloatingTree>
      <ChatAttachPopoverInner {...props} />
    </FloatingTree>
  )
}
