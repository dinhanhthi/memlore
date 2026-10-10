import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Eye, Lock, RotateCcw, Trash2 } from 'lucide-react'
import { useCapabilities } from '../../../hooks/useCapabilities'
import { trashAgeDays, trashRowStatus, useTrash } from '../../../hooks/useTrash'
import { getIntlLocale } from '../../../lib/dates'
import type { LockedView } from '../../../lib/tauri'
import type { Entry } from '../../../types/entry'
import { Button } from '../../common/Button'
import { ConfirmDialog } from '../../common/ConfirmDialog'
import { DesktopOnlyDialog } from '../../common/DesktopOnlyDialog'
import { EntryPreviewModal } from '../../chat/EntryPreviewModal'
import { SettingsGroup } from '../SettingsSurfaceCard'
import { SettingsSection } from '../SettingsSection'

/** The backend purges a locked entry only under `revealed`: under `covered`
 * the row is a redacted placeholder and the user cannot see what they would
 * destroy. Restore stays allowed — it loses nothing. */
function canPurge(entry: Entry, lockedView: LockedView): boolean {
  return !entry.is_locked || lockedView === 'revealed'
}

/** A web delete the desktop has not applied yet, for an entry this vault never
 * loaded: there is no body to preview. The empty `journal_id` is the marker
 * `untitledPendingEntry` (web/src/backend/commands/trash.ts) sets. */
function hasNothingToShow(entry: Entry): boolean {
  return entry.trash_pending_desktop === true && entry.journal_id === ''
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

interface TrashRowProps {
  entry: Entry
  nowSecs: number
  lockedView: LockedView
  /** False on web: the row sits in the desktop Trash, not here. */
  canAct: boolean
  onPreview: () => void
  onRestore: () => void
  onDeleteForever: () => void
}

function TrashRow({
  entry,
  nowSecs,
  lockedView,
  canAct,
  onPreview,
  onRestore,
  onDeleteForever,
}: TrashRowProps) {
  const { t, i18n } = useTranslation('settings')
  // Redacted under `covered`: the title is gone, so name it by its lock.
  const redacted = entry.is_locked && lockedView !== 'revealed'
  const title = redacted
    ? t('data_section.trash.locked_entry')
    : entry.title?.trim() || t('data_section.trash.untitled')
  const status = trashRowStatus(entry, nowSecs)
  const date = new Date(entry.entry_date * 1000).toLocaleDateString(getIntlLocale(i18n.language), {
    dateStyle: 'medium',
  })
  const meta =
    status.kind === 'pending'
      ? [date, t('data_section.trash.waiting_for_desktop')]
      : [
          date,
          canAct
            ? t('data_section.trash.deleted_ago', {
                count: trashAgeDays(entry.trashed_at ?? nowSecs, nowSecs),
              })
            : t('data_section.trash.in_desktop_trash'),
          t('data_section.trash.days_left', { count: status.daysLeft }),
        ]

  return (
    <div className="space-y-2 px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-fg truncate text-sm font-medium">{title}</span>
          {entry.is_locked && <Lock className="text-fg-muted size-3.5 shrink-0" aria-hidden />}
        </div>
        <p className="text-fg-muted mt-0.5 text-xs">{meta.join(' · ')}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {/* The preview refuses locked entries, so don't offer it. */}
        {!entry.is_locked && !hasNothingToShow(entry) && (
          <Button
            variant="secondary"
            size="xs"
            icon={<Eye className="size-3.5" aria-hidden />}
            onClick={onPreview}
          >
            {t('data_section.trash.preview')}
          </Button>
        )}
        <Button
          variant="secondary"
          size="xs"
          icon={<RotateCcw className="size-3.5" aria-hidden />}
          onClick={onRestore}
        >
          {t('data_section.trash.restore')}
        </Button>
        {canPurge(entry, lockedView) && (
          <Button variant="destructive" size="xs" onClick={onDeleteForever}>
            {t('data_section.trash.delete_forever')}
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * Settings → Data → Recently deleted. Lists the Trash and lets the user
 * preview, restore, or permanently delete entries. The 30-day retention
 * sweep lives in the backend; this screen only shows how long is left.
 */
export function TrashSettings() {
  const { t } = useTranslation('settings')
  const { entries, isLoading, error, lockedView, restore, deleteForever, empty } = useTrash()
  // On web the list is read-only: the actions open a desktop-only notice.
  const caps = useCapabilities()
  // Captured once per mount: the Settings tab is short-lived and a day count
  // that ticks over mid-visit is not worth a timer.
  const [nowSecs] = useState(() => Math.floor(Date.now() / 1000))
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Entry | null>(null)
  const [confirmEmpty, setConfirmEmpty] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [desktopOnly, setDesktopOnly] = useState(false)

  // A pending web delete is not in any Trash yet, so there is nothing to purge.
  const purgeable = entries.filter((e) => !e.trash_pending_desktop && canPurge(e, lockedView))
  const hasHeldBack = entries.some((e) => !canPurge(e, lockedView))

  // `ConfirmDialog` only logs a rejected action, so failures are caught here
  // and shown on the page.
  const run = async (action: () => Promise<unknown>) => {
    setActionError(null)
    try {
      await action()
    } catch (err) {
      setActionError(errorMessage(err))
    }
  }

  const shownError = actionError ?? error

  return (
    <div>
      <SettingsSection
        hint={`${t('data_section.trash.hint')} ${t('data_section.trash.older_versions_note')}`}
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <p className="text-fg-muted text-xs leading-snug">
              {hasHeldBack && t('data_section.trash.empty_trash_locked_note')}
            </p>
            <Button
              variant="destructive"
              size="xs"
              className="shrink-0"
              icon={<Trash2 className="size-3.5" aria-hidden />}
              disabled={purgeable.length === 0}
              onClick={() => (caps.trash ? setConfirmEmpty(true) : setDesktopOnly(true))}
            >
              {t('data_section.trash.empty_trash')}
            </Button>
          </div>

          {shownError && (
            <p role="alert" className="text-danger-text text-sm">
              {t('data_section.trash.error', { message: shownError })}
            </p>
          )}

          {entries.length === 0 ? (
            !isLoading && <p className="text-fg-muted text-sm">{t('data_section.trash.empty')}</p>
          ) : (
            // A long Trash scrolls inside its card instead of pushing the page.
            <SettingsGroup cardClassName="max-h-120 overflow-y-auto">
              {entries.map((entry) => (
                <TrashRow
                  key={entry.id}
                  entry={entry}
                  nowSecs={nowSecs}
                  lockedView={lockedView}
                  canAct={caps.trash}
                  onPreview={() => setPreviewId(entry.id)}
                  onRestore={() =>
                    caps.trash ? void run(() => restore(entry.id)) : setDesktopOnly(true)
                  }
                  onDeleteForever={() =>
                    caps.trash ? setPendingDelete(entry) : setDesktopOnly(true)
                  }
                />
              ))}
            </SettingsGroup>
          )}
        </div>
      </SettingsSection>

      {previewId && (
        <EntryPreviewModal
          key={previewId}
          entryId={previewId}
          allowDeleted
          onClose={() => setPreviewId(null)}
        />
      )}

      <DesktopOnlyDialog
        open={desktopOnly}
        onClose={() => setDesktopOnly(false)}
        title={t('data_section.trash.desktop_only_title')}
        body={t('data_section.trash.desktop_only_body')}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t('data_section.trash.delete_forever_title')}
        description={t('data_section.trash.delete_forever_body')}
        confirmLabel={t('data_section.trash.delete_forever')}
        onConfirm={() => {
          const id = pendingDelete?.id
          return id ? run(() => deleteForever(id)) : undefined
        }}
        onClose={() => setPendingDelete(null)}
      />

      <ConfirmDialog
        open={confirmEmpty}
        title={t('data_section.trash.empty_trash_title')}
        description={
          hasHeldBack
            ? `${t('data_section.trash.empty_trash_body', { count: purgeable.length })} ${t('data_section.trash.empty_trash_locked_note')}`
            : t('data_section.trash.empty_trash_body', { count: purgeable.length })
        }
        confirmLabel={t('data_section.trash.empty_trash')}
        onConfirm={() => run(empty)}
        onClose={() => setConfirmEmpty(false)}
      />
    </div>
  )
}
