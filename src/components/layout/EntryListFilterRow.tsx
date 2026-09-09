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
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  EyeOff,
  History,
  LockKeyhole,
  Star,
  Unlock,
} from 'lucide-react'
import { useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/cn'
import {
  availableLockFilterOptions,
  isLockFilterMenuVisible,
  resolveLockFilterVisibility,
  type LockFilter,
  type SortOrder,
  type TimeRange,
} from '../../lib/entryFilterSort'
import { useInvisibleLockStore } from '../../stores/invisibleLockStore'
import { useSecondLockStore } from '../../stores/secondLockStore'
import type { Journal } from '../../types/journal'
import { PillButton } from '../common/PillButton'
import { JournalScopePicker } from '../journals/JournalScopePicker'
import { RangePill } from '../common/RangePill'
import { Tooltip } from '../common/Tooltip'

interface EntryListFilterRowProps {
  range: TimeRange
  sort: SortOrder
  lockFilter: LockFilter
  journalId: string | null
  journals: Journal[]
  starred: boolean
  onRangeChange: (range: TimeRange) => void
  onSortChange: (sort: SortOrder) => void
  onLockFilterChange: (lockFilter: LockFilter) => void
  onJournalChange: (journalId: string | null) => void
  onStarredChange: (starred: boolean) => void
}

const SORT_OPTIONS: SortOrder[] = ['newest', 'oldest', 'recentlyEdited']

export function EntryListFilterRow({
  range,
  sort,
  lockFilter,
  journalId,
  journals,
  starred,
  onRangeChange,
  onSortChange,
  onLockFilterChange,
  onJournalChange,
  onStarredChange,
}: EntryListFilterRowProps) {
  const { t } = useTranslation('nav')
  const secondLockEnabled = useSecondLockStore((s) => s.isEnabled)
  const secondLockSessionUnlocked = useSecondLockStore((s) => s.isSessionUnlocked)
  const showExistence = useSecondLockStore((s) => s.showExistence)
  const invisibleSessionUnlocked = useInvisibleLockStore((s) => s.activeVaultId != null)

  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <Tooltip content={t('entry_list.filter.starred_tooltip')}>
        <PillButton
          selected={starred}
          aria-pressed={starred}
          aria-label={t('entry_list.filter.starred_label')}
          onClick={() => onStarredChange(!starred)}
          className="size-6 justify-center px-0"
        >
          <Star className="size-3" strokeWidth={1.75} fill={starred ? 'currentColor' : 'none'} />
        </PillButton>
      </Tooltip>
      <LockFilterPill
        lockFilter={lockFilter}
        onChange={onLockFilterChange}
        secondLockEnabled={secondLockEnabled}
        secondLockSessionUnlocked={secondLockSessionUnlocked}
        showExistence={showExistence}
        invisibleSessionUnlocked={invisibleSessionUnlocked}
        t={t}
      />
      <JournalScopePicker journalId={journalId} journals={journals} onChange={onJournalChange} />
      <RangePill range={range} onChange={onRangeChange} t={t} />
      <SortPill sort={sort} onChange={onSortChange} t={t} />
      <span className="flex-1" />
    </div>
  )
}

type TFn = ReturnType<typeof useTranslation<'nav'>>['t']

// ─── Sort pill ──────────────────────────────────────────────────────────────

interface SortPillProps {
  sort: SortOrder
  onChange: (sort: SortOrder) => void
  t: TFn
}

function SortPill({ sort, onChange, t }: SortPillProps) {
  const [open, setOpen] = useState(false)
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

  const isDefault = sort === 'newest'
  const SortIcon = sortFilterIcon(sort)

  return (
    <>
      <Tooltip content={sortLabel(sort, t)}>
        <PillButton
          ref={refs.setReference}
          selected={!isDefault}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          aria-label={t('entry_list.filter.sort_menu_label')}
          className="size-6 justify-center px-0"
          {...getReferenceProps()}
        >
          <SortIcon className="size-3" strokeWidth={1.75} />
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
            {SORT_OPTIONS.map((s, i) => {
              const selected = s === sort
              const ItemIcon = sortFilterIcon(s)
              return (
                <button
                  key={s}
                  ref={(node) => {
                    listRef.current[i] = node
                  }}
                  type="button"
                  role="menuitem"
                  tabIndex={activeIndex === i ? 0 : -1}
                  {...getItemProps({
                    onClick: () => {
                      setOpen(false)
                      onChange(s)
                    },
                  })}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm',
                    'hover:bg-panel-2 transition-colors',
                    activeIndex === i && !selected && 'bg-panel-2',
                    selected && 'bg-accent-soft text-accent-text',
                  )}
                >
                  <span className="inline-flex items-center gap-2">
                    <ItemIcon className="size-3.5 shrink-0" strokeWidth={1.75} />
                    <span>{sortLabel(s, t)}</span>
                  </span>
                  {selected && <span aria-hidden="true">✓</span>}
                </button>
              )
            })}
          </div>
        </FloatingPortal>
      )}
    </>
  )
}

function sortFilterIcon(s: SortOrder) {
  switch (s) {
    case 'newest':
      return ArrowDownWideNarrow
    case 'oldest':
      return ArrowUpNarrowWide
    case 'recentlyEdited':
      return History
  }
}

function sortLabel(s: SortOrder, t: TFn): string {
  switch (s) {
    case 'newest':
      return t('entry_list.filter.sort.newest')
    case 'oldest':
      return t('entry_list.filter.sort.oldest')
    case 'recentlyEdited':
      return t('entry_list.filter.sort.recentlyEdited')
  }
}

// ─── Lock filter pill ───────────────────────────────────────────────────────

interface LockFilterPillProps {
  lockFilter: LockFilter
  onChange: (lockFilter: LockFilter) => void
  secondLockEnabled: boolean
  secondLockSessionUnlocked: boolean
  showExistence: boolean
  invisibleSessionUnlocked: boolean
  t: TFn
}

function LockFilterPill({
  lockFilter,
  onChange,
  secondLockEnabled,
  secondLockSessionUnlocked,
  showExistence,
  invisibleSessionUnlocked,
  t,
}: LockFilterPillProps) {
  const visibility = useMemo(
    () =>
      resolveLockFilterVisibility({
        secondLockEnabled,
        secondLockSessionUnlocked,
        showExistence,
        invisibleSessionUnlocked,
      }),
    [secondLockEnabled, secondLockSessionUnlocked, showExistence, invisibleSessionUnlocked],
  )
  const lockOptions = useMemo(() => availableLockFilterOptions(visibility), [visibility])
  const menuVisible = isLockFilterMenuVisible(visibility)

  const [open, setOpen] = useState(false)
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

  const isDefault = lockFilter === 'all'

  if (!menuVisible) {
    return null
  }

  const LockIcon = lockFilterIcon(lockFilter)

  return (
    <>
      <Tooltip content={lockLabel(lockFilter, t)}>
        <PillButton
          ref={refs.setReference}
          selected={!isDefault}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          aria-label={t('entry_list.filter.lock_menu_label')}
          className="size-6 justify-center px-0"
          {...getReferenceProps()}
        >
          <LockIcon className="size-3" strokeWidth={1.75} />
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
            {lockOptions.map((f, i) => {
              const selected = f === lockFilter
              const ItemIcon = lockFilterIcon(f)
              return (
                <button
                  key={f}
                  ref={(node) => {
                    listRef.current[i] = node
                  }}
                  type="button"
                  role="menuitem"
                  tabIndex={activeIndex === i ? 0 : -1}
                  {...getItemProps({
                    onClick: () => {
                      setOpen(false)
                      onChange(f)
                    },
                  })}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm',
                    'hover:bg-panel-2 transition-colors',
                    activeIndex === i && !selected && 'bg-panel-2',
                    selected && 'bg-accent-soft text-accent-text',
                  )}
                >
                  <span className="inline-flex items-center gap-2">
                    <ItemIcon className="size-3.5 shrink-0" strokeWidth={1.75} />
                    <span>{lockLabel(f, t)}</span>
                  </span>
                  {selected && <span aria-hidden="true">✓</span>}
                </button>
              )
            })}
          </div>
        </FloatingPortal>
      )}
    </>
  )
}

function lockFilterIcon(f: LockFilter) {
  switch (f) {
    case 'all':
      // Footer "Lock app" control uses Unlock.
      return Unlock
    case 'secondLocked':
      // Footer second-lock control uses LockKeyhole when locked.
      return LockKeyhole
    case 'invisibleLocked':
      // Footer invisible-lock control uses EyeOff.
      return EyeOff
  }
}

function lockLabel(f: LockFilter, t: TFn): string {
  switch (f) {
    case 'all':
      return t('entry_list.filter.lock.all')
    case 'secondLocked':
      return t('entry_list.filter.lock.secondLocked')
    case 'invisibleLocked':
      return t('entry_list.filter.lock.invisibleLocked')
  }
}
