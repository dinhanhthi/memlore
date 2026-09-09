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
import { ChevronDown } from 'lucide-react'
import { useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/cn'
import type { Journal } from '../../types/journal'
import { PillButton } from '../common/PillButton'
import { Tooltip } from '../common/Tooltip'
import { JournalAllIcon } from './JournalAllIcon'

interface JournalScopePickerProps {
  journalId: string | null
  journals: Journal[]
  onChange: (journalId: string | null) => void
  /** When true (default), prepends an "All journals" option — the filter use.
   * Set false to use it as a target selector where a concrete journal must be
   * picked (e.g. Daily Chat "Save as entry"). */
  allowAll?: boolean
  /** When true, the trigger shows the selected journal's name + a chevron next
   * to the color dot (default: icon-only, used by the compact filter row). */
  showLabel?: boolean
}

export function JournalScopePicker({
  journalId,
  journals,
  onChange,
  allowAll = true,
  showLabel = false,
}: JournalScopePickerProps) {
  const { t } = useTranslation('nav')
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const listRef = useRef<Array<HTMLElement | null>>([])
  const menuId = useId()
  const options = useMemo(
    () =>
      allowAll
        ? [{ id: null, name: t('entry_list.filter.journal.all'), color: null }, ...journals]
        : journals,
    [journals, t, allowAll],
  )
  const selectedJournal = journalId
    ? (journals.find((journal) => journal.id === journalId) ?? null)
    : null
  const tooltipLabel = selectedJournal?.name ?? t('entry_list.filter.journal.all')

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

  return (
    <>
      <Tooltip content={tooltipLabel} placement="bottom" disabled={open || showLabel}>
        <PillButton
          ref={refs.setReference}
          selected={journalId !== null}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          aria-label={t('entry_list.filter.journal.menu_label')}
          className={showLabel ? 'h-8 gap-1.5 px-2.5 text-xs' : 'w-6 justify-center px-0'}
          {...getReferenceProps()}
        >
          {journalId === null ? (
            <JournalAllIcon className={cn('shrink-0', showLabel ? 'size-3.5' : 'size-3')} />
          ) : (
            <span
              aria-hidden="true"
              className={cn(
                'shrink-0 rounded-full',
                showLabel ? 'size-3.5' : 'size-3',
                selectedJournal?.color ? '' : 'bg-accent',
              )}
              style={
                selectedJournal?.color ? { backgroundColor: selectedJournal.color } : undefined
              }
            />
          )}
          {showLabel && (
            <>
              <span className="max-w-40 truncate">{tooltipLabel}</span>
              <ChevronDown className="size-3.5 shrink-0" strokeWidth={1.75} />
            </>
          )}
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
              'bg-elevated flex flex-col gap-1 rounded-xl shadow-xl',
              // z-1001 sits above the Modal overlay (z-1000) so the menu isn't
              // clipped or blurred behind it when used inside a dialog.
              'border-border-default z-1001 min-w-45 overflow-hidden border p-1',
            )}
          >
            {options.map((option, i) => {
              const selected = option.id === journalId
              return (
                <button
                  key={option.id ?? 'all'}
                  ref={(node) => {
                    listRef.current[i] = node
                  }}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  tabIndex={activeIndex === i ? 0 : -1}
                  {...getItemProps({
                    onClick: () => {
                      setOpen(false)
                      onChange(option.id)
                    },
                  })}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-sm',
                    'hover:bg-panel-2 transition-colors',
                    activeIndex === i && !selected && 'bg-panel-2',
                    selected && 'bg-accent-soft text-accent-text',
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {option.id === null ? (
                      <JournalAllIcon className="size-3.5" />
                    ) : (
                      <span
                        aria-hidden="true"
                        className={cn(
                          'size-3.5 shrink-0 rounded-full',
                          option.color ? '' : 'bg-accent',
                        )}
                        style={option.color ? { backgroundColor: option.color } : undefined}
                      />
                    )}
                    <span className="truncate">{option.name}</span>
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
