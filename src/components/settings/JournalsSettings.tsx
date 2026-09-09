import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EyeOff, LockKeyhole, LockKeyholeOpen, Pencil, Plus, Trash2 } from 'lucide-react'
import { emitJournalsChanged, useJournals } from '../../hooks/useJournals'
import { emitEntriesChanged } from '../../hooks/useEntries'
import { useSecondLock } from '../../hooks/useSecondLock'
import { useInvisibleLock } from '../../hooks/useInvisibleLock'
import { RestoredScroll } from '../common/RestoredScroll'
import { Button } from '../common/Button'
import { DeleteConfirmModal } from '../common/DeleteConfirmModal'
import { JournalForm } from '../journals/JournalForm'
import { JournalColorBadge } from '../journals/JournalColorBadge'
import { SecondLockIntroModal } from '../common/SecondLockIntroModal'
import { SecondLockPromptModal } from '../common/SecondLockPromptModal'
import { Tooltip } from '../common/Tooltip'
import type { Journal } from '../../types/journal'
import { decideJournalLock } from '../../lib/journalLockDecision'
import { SettingsSurfaceCard } from './SettingsSurfaceCard'

/// Settings → Journals — full CRUD list. Mirrors the sidebar JournalPicker's
/// add/edit/delete flow but presents every journal in a flat list with inline
/// row actions, so this is the place to do bulk maintenance.
///
/// Reuses `JournalForm` (modal) for create + edit and the same red-icon
/// confirm dialog shell as Sidebar.tsx for delete.
export function JournalsSettings() {
  const { t } = useTranslation('settings')
  const { journals, createJournal, updateJournal, deleteJournal, getEntryCount, refresh } =
    useJournals()
  const secondLock = useSecondLock(false)
  const invisibleLock = useInvisibleLock(false)

  const [showForm, setShowForm] = useState(false)
  const [editingJournal, setEditingJournal] = useState<Journal | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [secondLockIntroOpen, setSecondLockIntroOpen] = useState(false)
  const [unlockTarget, setUnlockTarget] = useState<Journal | null>(null)

  const [deleteTarget, setDeleteTarget] = useState<Journal | null>(null)
  const [deleteEntryCount, setDeleteEntryCount] = useState(0)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const closeForm = () => {
    setShowForm(false)
    setEditingJournal(null)
    setFormError(null)
  }

  const handleSave = async (
    name: string,
    color: string | undefined,
    autoTagIds: string[] | undefined,
  ) => {
    try {
      setFormError(null)
      if (editingJournal) {
        await updateJournal(editingJournal.id, name, color, autoTagIds)
      } else {
        // In create mode the form passes either the picked list or
        // `undefined`. Collapse to an empty array to mean "no auto-tags".
        await createJournal(name, color, autoTagIds ?? [])
      }
      closeForm()
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : t('journals_section.save_failed'))
    }
  }

  const handleDeleteClick = async (journal: Journal) => {
    try {
      const count = await getEntryCount(journal.id)
      setDeleteEntryCount(count)
    } catch {
      setDeleteEntryCount(0)
    }
    setDeleteTarget(journal)
  }

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return
    try {
      setDeleteError(null)
      await deleteJournal(deleteTarget.id)
      setDeleteTarget(null)
    } catch (err: unknown) {
      setDeleteError(err instanceof Error ? err.message : t('journals_section.delete_failed'))
    }
  }

  const handleToggleJournalLock = async (journal: Journal) => {
    // Removing the second lock is a persistent change to the journal flag,
    // so gate it behind the second-lock password. Locking needs no auth.
    const decision = decideJournalLock({
      secondLockEnabled: secondLock.isEnabled,
      isLocked: journal.is_locked,
      passwordVerified: null,
    })
    if (decision === 'prompt-enable') {
      setSecondLockIntroOpen(true)
      return
    }
    if (decision === 'prompt-unlock') {
      setUnlockTarget(journal)
      return
    }
    if (decision !== 'lock') return

    await secondLock.setJournalLocked(journal.id, true)
    refresh()
    emitJournalsChanged()
    emitEntriesChanged()
  }

  const handleUnlockVerified = async () => {
    if (!unlockTarget) return
    if (
      decideJournalLock({
        secondLockEnabled: true,
        isLocked: true,
        passwordVerified: true,
      }) !== 'unlock'
    ) {
      return
    }
    try {
      await secondLock.setJournalLocked(unlockTarget.id, false)
      setUnlockTarget(null)
      refresh()
      emitJournalsChanged()
      emitEntriesChanged()
    } catch {
      // setJournalLocked failure surfaces via the row refresh; keep modal
      // open so the user can retry.
    }
  }

  const handleToggleJournalInvisible = async (journal: Journal) => {
    try {
      await invisibleLock.markJournalInvisible(journal.id, !journal.is_invisible)
      refresh()
      emitJournalsChanged()
      emitEntriesChanged()
    } catch {
      // Keep this action deniable: no persistent row error about invisible state.
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 px-6 pt-6 pb-3">
        <h1 className="font-title text-fg text-3xl font-extrabold">
          {t('categories.journals.label')}
        </h1>
        <p className="text-fg-muted mt-1 max-w-prose text-sm leading-snug">
          {t('categories.journals.description')}
        </p>
      </div>

      <RestoredScroll
        view="settings"
        sub="journals"
        className="min-h-0 flex-1 overflow-y-auto p-6 pt-2 outline-none"
      >
        <div className="max-w-180">
          <SettingsSurfaceCard divided>
            {journals.length === 0 ? (
              <p className="text-fg-muted px-4 py-6 text-center text-sm">
                {t('journals_section.empty')}
              </p>
            ) : (
              journals.map((journal) => (
                <div
                  key={journal.id}
                  className="hover:bg-surface-row-hover flex items-center gap-3 px-4 py-3 transition-colors duration-(--motion-duration-fast) ease-(--motion-ease-out-expo) motion-reduce:transition-none"
                >
                  <JournalColorBadge color={journal.color} size="lg" />

                  <div className="min-w-0 flex-1">
                    <p className="text-fg truncate text-sm font-medium">{journal.name}</p>
                  </div>

                  <div className="flex shrink-0 gap-1">
                    <Tooltip
                      content={t(
                        journal.is_locked
                          ? 'journals_section.unlock_tooltip'
                          : 'journals_section.lock_tooltip',
                        { name: journal.name },
                      )}
                      placement="top"
                    >
                      <Button
                        variant="ghost"
                        size="md"
                        className="h-8! w-8! shrink-0 justify-center px-0!"
                        aria-label={t(
                          journal.is_locked
                            ? 'journals_section.unlock_aria'
                            : 'journals_section.lock_aria',
                          { name: journal.name },
                        )}
                        onClick={() => void handleToggleJournalLock(journal)}
                      >
                        {journal.is_locked ? (
                          <LockKeyhole className="text-accent size-4" />
                        ) : (
                          <LockKeyholeOpen className="size-4" />
                        )}
                      </Button>
                    </Tooltip>
                    {invisibleLock.isSessionUnlocked && (
                      <Tooltip
                        content={journal.is_invisible ? 'Remove from invisible' : 'Make invisible'}
                        placement="top"
                      >
                        <Button
                          variant="ghost"
                          size="md"
                          className="h-8! w-8! shrink-0 justify-center px-0!"
                          aria-label={
                            journal.is_invisible
                              ? `Remove ${journal.name} from invisible`
                              : `Make ${journal.name} invisible`
                          }
                          onClick={() => void handleToggleJournalInvisible(journal)}
                        >
                          <EyeOff className="size-4" />
                        </Button>
                      </Tooltip>
                    )}
                    <Button
                      variant="ghost"
                      size="md"
                      className="h-8! w-8! shrink-0 justify-center px-0!"
                      aria-label={t('journals_section.edit_aria', { name: journal.name })}
                      onClick={() => {
                        setEditingJournal(journal)
                        setShowForm(true)
                      }}
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="md"
                      className="h-8! w-8! shrink-0 justify-center px-0!"
                      aria-label={t('journals_section.delete_aria', { name: journal.name })}
                      onClick={() => void handleDeleteClick(journal)}
                    >
                      <Trash2 className="text-danger size-4" />
                    </Button>
                  </div>
                </div>
              ))
            )}
          </SettingsSurfaceCard>

          <div className="mt-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setEditingJournal(null)
                setShowForm(true)
              }}
            >
              <Plus className="size-4" />
              {t('journals_section.new')}
            </Button>
          </div>
        </div>
      </RestoredScroll>

      {showForm && (
        <JournalForm
          journal={editingJournal}
          onSave={handleSave}
          onCancel={closeForm}
          externalError={formError}
        />
      )}

      {deleteTarget && (
        <DeleteConfirmModal
          title={t('journals_section.delete_title')}
          body={
            <>
              <strong>{deleteTarget.name}</strong> {t('journals_section.delete_removed')}
              {deleteEntryCount > 0 && (
                <>
                  {' '}
                  {t('journals_section.delete_with_entries', {
                    count: deleteEntryCount,
                    noun:
                      deleteEntryCount === 1
                        ? t('journals_section.entry_one')
                        : t('journals_section.entry_other'),
                  })}
                </>
              )}
              <span className="mt-2 block">{t('journals_section.delete_sync_warning')}</span>
            </>
          }
          error={deleteError}
          onCancel={() => {
            setDeleteTarget(null)
            setDeleteError(null)
          }}
          onConfirm={handleConfirmDelete}
        />
      )}

      <SecondLockIntroModal
        open={secondLockIntroOpen}
        onClose={() => setSecondLockIntroOpen(false)}
      />

      <SecondLockPromptModal
        open={unlockTarget !== null}
        onClose={() => setUnlockTarget(null)}
        title={t('journals_section.unlock_title')}
        description={t('journals_section.unlock_description', { name: unlockTarget?.name ?? '' })}
        mode="confirm"
        onVerified={handleUnlockVerified}
      />
    </div>
  )
}
