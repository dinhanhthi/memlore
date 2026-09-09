import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  useFloating,
  offset,
  flip,
  shift,
  autoUpdate,
  FloatingPortal,
  useClick,
  useDismiss,
  useInteractions,
  useListNavigation,
  useRole,
} from '@floating-ui/react'
import { Tooltip } from '../common/Tooltip'
import { moveEntryToJournal } from '../../lib/tauri'
import { emitEntriesChanged } from '../../hooks/useEntries'
import { useJournalStore } from '../../stores/journalStore'
import { cn } from '../../lib/cn'
import type { Journal } from '../../types/journal'

/** Journal colour dot in the editor footer; opens a move-to-journal menu
 *  when more than one journal exists. */
export function EntryJournalBadge({ journal, entryId }: { journal: Journal; entryId: string }) {
  const { t } = useTranslation('editor')
  const journals = useJournalStore((s) => s.journals)
  const visibleJournals = journals.filter((j) => !j.is_deleted)
  const canSwitch = visibleJournals.some((j) => j.id !== journal.id)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const listRef = useRef<Array<HTMLElement | null>>([])
  const menuId = useId()

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'top-start',
    whileElementsMounted: autoUpdate,
    middleware: [offset(8), flip(), shift({ padding: 8 })],
  })

  const click = useClick(context)
  const dismiss = useDismiss(context)
  const role = useRole(context, { role: 'menu' })
  const listNav = useListNavigation(context, {
    listRef,
    activeIndex,
    onNavigate: setActiveIndex,
    loop: true,
    enabled: open,
  })
  const { getReferenceProps, getFloatingProps, getItemProps } = useInteractions([
    click,
    dismiss,
    role,
    listNav,
  ])

  async function handleSelect(targetId: string) {
    setOpen(false)
    if (targetId === journal.id) return
    try {
      await moveEntryToJournal(entryId, targetId)
      emitEntriesChanged()
    } catch (err) {
      console.error('Failed to move entry to journal:', err)
    }
  }

  const dot = (
    <span
      aria-hidden
      className="inline-block size-4.5 shrink-0 rounded-full"
      style={{ backgroundColor: journal.color ?? 'var(--color-accent)' }}
    />
  )

  if (!canSwitch) {
    return (
      <Tooltip content={journal.name} placement="top">
        <span
          role="img"
          aria-label={journal.name}
          className="inline-flex size-7 items-center justify-center"
        >
          {dot}
        </span>
      </Tooltip>
    )
  }

  return (
    <>
      <Tooltip
        content={t('pills.journal_switch_tooltip', {
          name: journal.name,
          defaultValue: '{{name}} — Move to another journal',
        })}
        placement="top"
        disabled={open}
      >
        <button
          ref={refs.setReference}
          type="button"
          aria-label={t('pills.journal_switch_aria', {
            name: journal.name,
            defaultValue: 'Change journal ({{name}})',
          })}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          className="hover:bg-surface-subtle inline-flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors outline-none"
          {...getReferenceProps()}
        >
          {dot}
        </button>
      </Tooltip>
      {open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            id={menuId}
            aria-label={t('pills.journal_switch_menu_aria', { defaultValue: 'Choose journal' })}
            {...getFloatingProps()}
            className="border-border-default bg-elevated z-50 flex max-h-80 min-w-45 flex-col gap-1 overflow-y-auto rounded-xl border p-1 shadow-lg"
          >
            {visibleJournals.map((option, i) => {
              const selected = option.id === journal.id
              return (
                <button
                  key={option.id}
                  ref={(node) => {
                    listRef.current[i] = node
                  }}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  tabIndex={activeIndex === i ? 0 : -1}
                  {...getItemProps({
                    onClick: () => {
                      void handleSelect(option.id)
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
                    <span
                      aria-hidden
                      className="size-3.5 shrink-0 rounded-full"
                      style={{
                        backgroundColor: option.color ?? 'var(--color-accent)',
                      }}
                    />
                    <span className="truncate">{option.name}</span>
                  </span>
                  {selected && <span aria-hidden>✓</span>}
                </button>
              )
            })}
          </div>
        </FloatingPortal>
      )}
    </>
  )
}
