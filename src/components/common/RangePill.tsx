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
  useListNavigation,
  useRole,
} from '@floating-ui/react'
import { Calendar, CalendarClock, CalendarDays, CalendarFold, CalendarRange } from 'lucide-react'
import { useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/cn'
import { toISODate } from '../../lib/dates'
import type { TimeRange } from '../../lib/entryFilterSort'
import { Button } from './Button'
import { MiniDatePicker } from './MiniDatePicker'
import { Modal } from './Modal'
import { PillButton } from './PillButton'
import { Tooltip } from './Tooltip'

type TFn = ReturnType<typeof useTranslation<'nav'>>['t']

type RangePreset = 'all' | 'thisWeek' | 'thisMonth' | 'thisYear' | 'custom'

const RANGE_PRESETS: RangePreset[] = ['all', 'thisWeek', 'thisMonth', 'thisYear', 'custom']

function rangePreset(r: TimeRange): RangePreset {
  return r.kind
}

function rangeLabel(r: TimeRange, t: TFn): string {
  if (r.kind === 'custom' && r.fromDateIso && r.toDateIso) {
    return `${r.fromDateIso} → ${r.toDateIso}`
  }
  return rangePresetLabel(rangePreset(r), t)
}

function rangePresetLabel(p: RangePreset, t: TFn): string {
  switch (p) {
    case 'all':
      return t('entry_list.filter.range.all')
    case 'thisWeek':
      return t('entry_list.filter.range.thisWeek')
    case 'thisMonth':
      return t('entry_list.filter.range.thisMonth')
    case 'thisYear':
      return t('entry_list.filter.range.thisYear')
    case 'custom':
      return t('entry_list.filter.range.custom')
  }
}

// ─── Custom range dialog ────────────────────────────────────────────────────

interface CustomRangeDialogProps {
  initial: TimeRange & { kind: 'custom' }
  onCancel: () => void
  onApply: (next: TimeRange) => void
  t: TFn
}

function todayNoonSec(): number {
  const d = new Date()
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0).getTime() / 1000)
}

/**
 * Parse a YYYY-MM-DD ISO date into a Unix seconds timestamp anchored
 * at local noon. Noon is chosen so the round-trip through toISODate
 * is timezone-safe (any reasonable UTC offset leaves the day unchanged).
 */
function isoToSec(iso: string | null): number {
  if (!iso) return todayNoonSec()
  const YYYYMMDD = /^(\d{4})-(\d{2})-(\d{2})$/
  const m = YYYYMMDD.exec(iso)
  if (!m) return todayNoonSec()
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0)
  return Math.floor(d.getTime() / 1000)
}

function CustomRangeDialog({ initial, onCancel, onApply, t }: CustomRangeDialogProps) {
  const [fromSec, setFromSec] = useState<number>(() => isoToSec(initial.fromDateIso))
  const [toSec, setToSec] = useState<number>(() => isoToSec(initial.toDateIso))

  const fromIso = toISODate(fromSec)
  const toIso = toISODate(toSec)
  // ISO-8601 date strings are lexicographically sortable, so a string
  // compare avoids any timezone vs. parser inconsistency.
  const invalid = fromIso > toIso

  return (
    <Modal onClose={onCancel} maxWidth={620}>
      <Modal.Header>{t('entry_list.filter.custom_range_title')}</Modal.Header>
      <Modal.Body fitContent>
        <div className="flex items-start gap-4">
          <div className="flex flex-col gap-2">
            <span className="text-fg-muted text-xs font-medium">
              {t('entry_list.filter.custom_range_from')}
            </span>
            <MiniDatePicker value={fromSec} onChange={setFromSec} />
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-fg-muted text-xs font-medium">
              {t('entry_list.filter.custom_range_to')}
            </span>
            <MiniDatePicker value={toSec} onChange={setToSec} />
          </div>
        </div>
        {invalid && (
          <p className="text-danger-text mt-3 text-xs">
            {t('entry_list.filter.custom_range_invalid')}
          </p>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t('entry_list.filter.cancel')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={invalid}
          onClick={() => onApply({ kind: 'custom', fromDateIso: fromIso, toDateIso: toIso })}
        >
          {t('entry_list.filter.apply')}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}

// ─── Range pill ─────────────────────────────────────────────────────────────

interface RangePillProps {
  range: TimeRange
  onChange: (range: TimeRange) => void
  t: TFn
}

export function RangePill({ range, onChange, t }: RangePillProps) {
  const [open, setOpen] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const listRef = useRef<Array<HTMLElement | null>>([])
  const menuId = useId()

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-start',
    whileElementsMounted: autoUpdate,
    middleware: [offset(6), flip(), shift({ padding: 8 })],
  })

  const click = useClick(context)
  const dismiss = useDismiss(context)
  const role = useRole(context, { role: 'menu' })
  const listNav = useListNavigation(context, {
    listRef,
    activeIndex,
    onNavigate: setActiveIndex,
    loop: true,
  })
  const { getReferenceProps, getFloatingProps, getItemProps } = useInteractions([
    click,
    dismiss,
    role,
    listNav,
  ])

  const label = useMemo(() => rangeLabel(range, t), [range, t])
  const preset = rangePreset(range)
  const isDefault = preset === 'all'
  const RangeIcon = rangeFilterIcon(preset)

  const handlePreset = (next: RangePreset) => {
    if (next === 'custom') {
      setOpen(false)
      setCustomOpen(true)
      return
    }
    setOpen(false)
    onChange({ kind: next })
  }

  return (
    <>
      <Tooltip content={label}>
        <PillButton
          ref={refs.setReference}
          selected={!isDefault}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          aria-label={t('entry_list.filter.range_menu_label')}
          className="size-6 justify-center px-0"
          {...getReferenceProps()}
        >
          <RangeIcon className="size-3" strokeWidth={1.75} />
        </PillButton>
      </Tooltip>

      {open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            id={menuId}
            {...getFloatingProps()}
            className={cn(
              'bg-elevated rounded-xl shadow-xl',
              'border-border-default z-50 w-45 overflow-hidden border',
            )}
          >
            {RANGE_PRESETS.map((p, i) => {
              const selected = p === preset
              const ItemIcon = rangeFilterIcon(p)
              return (
                <button
                  key={p}
                  ref={(node) => {
                    listRef.current[i] = node
                  }}
                  type="button"
                  role="menuitem"
                  tabIndex={activeIndex === i ? 0 : -1}
                  {...getItemProps({ onClick: () => handlePreset(p) })}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm',
                    'hover:bg-panel-2 transition-colors',
                    activeIndex === i && !selected && 'bg-panel-2',
                    selected && 'bg-accent-soft text-accent-text',
                  )}
                >
                  <span className="inline-flex items-center gap-2">
                    <ItemIcon className="size-3.5 shrink-0" strokeWidth={1.75} />
                    <span>{rangePresetLabel(p, t)}</span>
                  </span>
                  {selected && <span aria-hidden="true">✓</span>}
                </button>
              )
            })}
          </div>
        </FloatingPortal>
      )}

      {customOpen && (
        <CustomRangeDialog
          initial={
            range.kind === 'custom' ? range : { kind: 'custom', fromDateIso: null, toDateIso: null }
          }
          onCancel={() => setCustomOpen(false)}
          onApply={(next) => {
            setCustomOpen(false)
            onChange(next)
          }}
          t={t}
        />
      )}
    </>
  )
}

function rangeFilterIcon(p: RangePreset) {
  switch (p) {
    case 'all':
      return CalendarRange
    case 'thisWeek':
      return CalendarDays
    case 'thisMonth':
      return Calendar
    case 'thisYear':
      return CalendarFold
    case 'custom':
      return CalendarClock
  }
}
