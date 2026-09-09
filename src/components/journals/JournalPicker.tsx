import { useState } from 'react'
import { useTranslation } from 'react-i18next'
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
import {
  ChevronDown,
  Pencil,
  Trash2,
  Plus,
  LockKeyhole,
  LockKeyholeOpen,
  EyeOff,
  Settings,
} from 'lucide-react'
import type { Journal } from '../../types/journal'
import { cn } from '../../lib/cn'
import { JournalAllIcon } from './JournalAllIcon'
import { Tooltip } from '../common/Tooltip'
import { useSecondLock } from '../../hooks/useSecondLock'
import { useInvisibleLock } from '../../hooks/useInvisibleLock'
import { SecondLockPromptModal } from '../common/SecondLockPromptModal'
import { emitJournalsChanged } from '../../hooks/useJournals'
import { emitEntriesChanged } from '../../hooks/useEntries'
import { shouldCloseOnOutsidePress, usePopoverState } from '../../hooks/usePopoverState'

interface JournalPickerProps {
  journals: Journal[]
  activeJournalId: string | null
  onSelectJournal: (id: string | null) => void
  onCreateJournal: () => void
  onEditJournal: (journal: Journal) => void
  onDeleteJournal: (journal: Journal) => void
  onToggleJournalLock: (journal: Journal) => void
  onOpenJournalSettings: () => void
  collapsed: boolean
}

/**
 * JournalPicker — bundle-shape trigger row + expanding popover (Chunk H2).
 *
 * Replaces the Phase 2 flat-list picker that always rendered every journal
 * inline. New shape matches `docs/design/project/xj/shell.jsx`: a
 * glass-subtle row shows the active journal, tapping it pops a menu with
 * "All Journals" + each journal + "New Journal". Edit / Delete stay inline
 * on each journal row and keep the popover open so the caller's modal can
 * own the subsequent flow.
 *
 * Collapsed sidebar → trigger shrinks to a small glass-subtle circle with
 * only the active-journal color dot; popover contents are unchanged.
 */
export function JournalPicker({
  journals,
  activeJournalId,
  onSelectJournal,
  onCreateJournal,
  onEditJournal,
  onDeleteJournal,
  onToggleJournalLock,
  onOpenJournalSettings,
  collapsed,
}: JournalPickerProps) {
  const { t } = useTranslation('editor')
  const secondLock = useSecondLock(false)
  const invisibleLock = useInvisibleLock(false)
  const { open, setOpen, closeOn } = usePopoverState()
  const [unlockTarget, setUnlockTarget] = useState<Journal | null>(null)

  const activeJournal = activeJournalId ? journals.find((j) => j.id === activeJournalId) : null
  const triggerLabel = activeJournal ? activeJournal.name : t('journal_picker.all_journals')

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: collapsed ? 'right-start' : 'bottom-start',
    whileElementsMounted: autoUpdate,
    middleware: [offset(collapsed ? 8 : 6), flip({ padding: 8 }), shift({ padding: 8 })],
  })

  const click = useClick(context)
  const dismiss = useDismiss(context, {
    // Keep the popover open while a Modal scrim is in the DOM so focus-restore
    // targets (Edit / Delete buttons) stay mounted.
    outsidePress: shouldCloseOnOutsidePress,
    // Escape is handled on `window` in usePopoverState — matches prior
    // behaviour and keeps the existing keydown(window) test contract.
    escapeKey: false,
  })
  const role = useRole(context, { role: 'dialog' })
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss, role])

  const selectJournal = (journal: Journal) => {
    if (journal.is_locked && secondLock.isEnabled && !secondLock.isSessionUnlocked) {
      setUnlockTarget(journal)
      closeOn('select-locked')
      return
    }

    onSelectJournal(journal.id)
    closeOn('select')
  }

  const handleInvisibleToggle = async (journal: Journal) => {
    try {
      await invisibleLock.markJournalInvisible(journal.id, !journal.is_invisible)
      emitJournalsChanged()
      emitEntriesChanged()
    } catch (error) {
      console.error('Failed to update invisible journal:', error)
    }
  }

  return (
    <>
      <div className="relative">
        {collapsed ? (
          <span
            ref={refs.setReference}
            className="inline-flex"
            {...getReferenceProps({
              'aria-label': t('journal_picker.open_aria'),
              'aria-haspopup': 'dialog',
              'aria-expanded': open,
            })}
          >
            <Tooltip content={triggerLabel} placement="right" disabled={open}>
              <button
                type="button"
                tabIndex={-1}
                aria-hidden="true"
                className="border-border-default bg-elevated grid h-9 w-9 cursor-pointer place-items-center rounded-full border transition-colors select-none"
              >
                {activeJournal ? (
                  <span
                    aria-hidden="true"
                    className="size-3.5 shrink-0 rounded-full"
                    style={{ background: activeJournal.color ?? 'var(--color-accent)' }}
                  />
                ) : (
                  <JournalAllIcon className="size-3.5" />
                )}
              </button>
            </Tooltip>
          </span>
        ) : (
          <button
            ref={refs.setReference}
            type="button"
            aria-label={t('journal_picker.open_aria')}
            aria-haspopup="dialog"
            aria-expanded={open}
            className="border-border-default bg-elevated flex h-9 w-full cursor-pointer items-center gap-2 rounded-full border px-2 pl-2 text-left transition-colors select-none"
            {...getReferenceProps()}
          >
            {activeJournal ? (
              <span
                aria-hidden="true"
                className="ml-1 h-3.5 w-3.5 shrink-0 rounded-full"
                style={{ background: activeJournal.color ?? 'var(--color-accent)' }}
              />
            ) : (
              <JournalAllIcon className="ml-1 size-3.5" />
            )}
            <span className="text-fg flex-1 overflow-hidden text-sm font-semibold tracking-[-.1px] text-ellipsis whitespace-nowrap">
              {triggerLabel}
            </span>
            <span className="text-fg-faint shrink-0">
              <ChevronDown className="size-4" strokeWidth={1.75} />
            </span>
          </button>
        )}

        {open && (
          <FloatingPortal>
            <div
              ref={refs.setFloating}
              style={floatingStyles}
              role="dialog"
              aria-label={t('journal_picker.dialog_aria')}
              data-testid="journal-picker-popover"
              className="border-border-default bg-elevated z-50 flex w-70 flex-col gap-1 overflow-hidden rounded-xl border p-1.5 shadow-lg"
              {...getFloatingProps()}
            >
              <PickerRow
                label={t('journal_picker.all_journals')}
                icon={<JournalAllIcon className="size-3.5" />}
                active={activeJournalId === null}
                onClick={() => {
                  onSelectJournal(null)
                  closeOn('select')
                }}
              />

              {journals.map((journal) => {
                const isActive = activeJournalId === journal.id
                return (
                  <div key={journal.id} className="group relative overflow-hidden">
                    <PickerRow
                      label={journal.name}
                      journal={journal}
                      active={isActive}
                      onClick={() => selectJournal(journal)}
                    />
                    <div className="absolute inset-y-0 right-1 flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                      <RowAction
                        ariaLabel={t(
                          journal.is_locked
                            ? 'journal_picker.unlock_aria'
                            : 'journal_picker.lock_aria',
                          { name: journal.name },
                        )}
                        tooltip={t(
                          journal.is_locked
                            ? 'journal_picker.unlock_tooltip'
                            : 'journal_picker.lock_tooltip',
                        )}
                        icon={
                          journal.is_locked ? (
                            <LockKeyhole className="text-accent/70 size-3.5" strokeWidth={1.75} />
                          ) : (
                            <LockKeyholeOpen className="size-3.5" strokeWidth={1.75} />
                          )
                        }
                        onClick={(e) => {
                          e.stopPropagation()
                          onToggleJournalLock(journal)
                          closeOn('lock')
                        }}
                      />
                      {invisibleLock.isSessionUnlocked && (
                        <RowAction
                          ariaLabel={t(
                            journal.is_invisible
                              ? 'journal_picker.remove_invisible_aria'
                              : 'journal_picker.make_invisible_aria',
                            {
                              name: journal.name,
                              defaultValue: journal.is_invisible
                                ? `Remove ${journal.name} from invisible`
                                : `Make ${journal.name} invisible`,
                            },
                          )}
                          tooltip={t(
                            journal.is_invisible
                              ? 'journal_picker.remove_invisible_tooltip'
                              : 'journal_picker.make_invisible_tooltip',
                            {
                              defaultValue: journal.is_invisible
                                ? 'Remove from invisible'
                                : 'Make invisible',
                            },
                          )}
                          icon={<EyeOff className="size-3.5" strokeWidth={1.75} />}
                          onClick={(e) => {
                            e.stopPropagation()
                            void handleInvisibleToggle(journal)
                            closeOn('invisible')
                          }}
                        />
                      )}
                      <RowAction
                        ariaLabel={t('journal_picker.edit_aria', { name: journal.name })}
                        tooltip={t('journal_picker.edit_tooltip')}
                        icon={<Pencil className="size-3.5" strokeWidth={1.75} />}
                        onClick={(e) => {
                          e.stopPropagation()
                          onEditJournal(journal)
                          closeOn('edit')
                        }}
                      />
                      <RowAction
                        ariaLabel={t('journal_picker.delete_aria', { name: journal.name })}
                        tooltip={t('journal_picker.remove_tooltip')}
                        variant="danger"
                        icon={<Trash2 className="size-3.5" strokeWidth={1.75} />}
                        onClick={(e) => {
                          e.stopPropagation()
                          onDeleteJournal(journal)
                          closeOn('delete')
                        }}
                      />
                    </div>
                  </div>
                )
              })}

              <div className="border-border-default my-1 border-t" />

              <PickerRow
                label={t('journal_picker.new_journal')}
                icon={<Plus className="size-4" strokeWidth={1.75} />}
                onClick={() => {
                  onCreateJournal()
                  closeOn('create')
                }}
              />

              <div className="border-border-default my-1 border-t" />

              <PickerRow
                label={t('journal_picker.manage_journals')}
                icon={<Settings className="size-4" strokeWidth={1.75} />}
                onClick={() => {
                  onOpenJournalSettings()
                  closeOn('settings')
                }}
              />
            </div>
          </FloatingPortal>
        )}
      </div>

      <SecondLockPromptModal
        open={unlockTarget !== null}
        onClose={() => setUnlockTarget(null)}
        title={t('journal_picker.unlock_title')}
        description={t('journal_picker.unlock_description', { name: unlockTarget?.name ?? '' })}
        mode="unlock-session"
        onVerified={() => {
          if (unlockTarget) {
            onSelectJournal(unlockTarget.id)
            closeOn('select')
          }
          setUnlockTarget(null)
        }}
      />
    </>
  )
}

interface PickerRowProps {
  label: string
  active?: boolean
  icon?: React.ReactNode
  journal?: Journal
  onClick: () => void
}

function PickerRow({ label, active, icon, journal, onClick }: PickerRowProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-current={active ? 'true' : undefined}
      onClick={onClick}
      className={cn(
        'flex w-full min-w-0 items-center gap-2 rounded-lg py-1.5 text-left text-sm',
        journal ? 'pr-2.5 pl-1.5' : 'pr-2.5 pl-2.5',
        'transition-colors duration-150',
        active ? 'bg-accent-soft text-accent-text font-semibold' : 'text-fg hover:bg-panel-1',
      )}
    >
      {journal && (
        <span
          aria-hidden="true"
          className="ml-1 size-3.5 shrink-0 rounded-full"
          style={{ background: journal.color ?? 'var(--color-accent)' }}
        />
      )}
      {icon && <span className="text-fg-muted shrink-0">{icon}</span>}
      <span
        className={cn(
          'min-w-0 flex-1',
          journal
            ? 'overflow-hidden text-ellipsis whitespace-nowrap group-hover:max-w-[calc(100%-7.5rem)]'
            : 'truncate',
        )}
      >
        {label}
      </span>
    </button>
  )
}

interface RowActionProps {
  ariaLabel: string
  tooltip: string
  icon: React.ReactNode
  onClick: (e: React.MouseEvent) => void
  variant?: 'default' | 'danger'
}

function RowAction({ ariaLabel, tooltip, icon, onClick, variant = 'default' }: RowActionProps) {
  return (
    <Tooltip content={tooltip} placement="bottom">
      <button
        type="button"
        aria-label={ariaLabel}
        onClick={onClick}
        className={cn(
          'grid h-7 w-7 cursor-pointer place-items-center rounded-md transition-colors',
          variant === 'danger'
            ? 'text-fg-secondary hover:bg-danger/15 hover:text-danger'
            : 'text-fg-secondary hover:bg-border-default hover:text-fg',
        )}
      >
        {icon}
      </button>
    </Tooltip>
  )
}
