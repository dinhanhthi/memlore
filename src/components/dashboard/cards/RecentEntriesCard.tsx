import { useState, type MouseEvent } from 'react'
import { ArrowRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useRecentEntries } from '../../../hooks/useRecentEntries'
import { formatCompactDate } from '../../../lib/dates'
import { isMiddleClick, isNewTabModifier } from '../../../lib/modifierClick'
import { useEntryStore } from '../../../stores/entryStore'
import { useTabStore } from '../../../stores/tabStore'
import type { Entry } from '../../../types/entry'
import { Button } from '../../common/Button'
import { SecondLockPromptModal } from '../../common/SecondLockPromptModal'
import { DashboardCard } from '../DashboardCard'

function openEntry(entry: Entry, background: boolean) {
  if (background) {
    useEntryStore.getState().mergeEntries([entry])
    useTabStore.getState().newTab(
      {
        activeView: 'entries',
        journalId: entry.journal_id,
        selectedEntryId: entry.id,
        selectedCalendarDate: null,
        selectedTagId: null,
      },
      { background: true },
    )
    return
  }
  useTabStore.getState().updateActiveTab({
    activeView: 'entries',
    selectedEntryId: entry.id,
  })
}

export function RecentEntriesCard() {
  const { t, i18n } = useTranslation('dashboard')
  const { entries, isLoading, error } = useRecentEntries(4)
  const [unlockEntryId, setUnlockEntryId] = useState<string | null>(null)

  return (
    <>
      <DashboardCard
        title={t('cards.recent_entries')}
        action={
          <Button
            variant="ghost"
            size="xs"
            icon={<ArrowRight className="size-4" />}
            onClick={() =>
              useTabStore.getState().updateActiveTab({
                activeView: 'entries',
                selectedEntryId: null,
              })
            }
          >
            {t('actions.entries')}
          </Button>
        }
      >
        {isLoading ? (
          <div className="flex flex-col gap-2">
            {[0, 1, 2, 3].map((key) => (
              <div key={key} className="bg-panel-2 h-5 rounded-md motion-safe:animate-pulse" />
            ))}
          </div>
        ) : error ? (
          <p className="text-fg-muted text-sm" role="alert">
            {error}
          </p>
        ) : entries.length === 0 ? (
          <p className="text-fg-muted text-sm">{t('recent.empty')}</p>
        ) : (
          <div className="-mx-3 flex flex-col">
            {entries.map((entry) => {
              const isCoveredLocked =
                entry.is_locked &&
                entry.title === null &&
                entry.preview_text === null &&
                entry.content_text === null
              return (
                <button
                  key={entry.id}
                  type="button"
                  className="hover:bg-panel-2 flex w-full items-start justify-between gap-3 rounded-lg px-3 py-2 text-left"
                  onClick={(e: MouseEvent<HTMLButtonElement>) => {
                    if (isCoveredLocked) {
                      setUnlockEntryId(entry.id)
                      return
                    }
                    if (isNewTabModifier(e)) {
                      e.preventDefault()
                      openEntry(entry, true)
                      return
                    }
                    openEntry(entry, false)
                  }}
                  onMouseDown={(e) => {
                    if (isMiddleClick(e)) e.preventDefault()
                  }}
                  onAuxClick={(e) => {
                    if (!isMiddleClick(e)) return
                    e.preventDefault()
                    if (isCoveredLocked) {
                      setUnlockEntryId(entry.id)
                      return
                    }
                    openEntry(entry, true)
                  }}
                >
                  <span className="text-fg line-clamp-2 min-w-0 text-sm">
                    {isCoveredLocked
                      ? t('entry_card.locked_entry', { ns: 'editor' })
                      : entry.title || t('media_gallery.untitled', { ns: 'nav' })}
                  </span>
                  <span className="text-fg-muted text-2xs shrink-0">
                    {formatCompactDate(entry.entry_date, i18n.language)}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </DashboardCard>
      <SecondLockPromptModal
        open={unlockEntryId !== null}
        onClose={() => setUnlockEntryId(null)}
        title={t('entry_card.unlock_second_lock_title', { ns: 'editor' })}
        mode="unlock-session"
        onVerified={() => {
          const id = unlockEntryId
          setUnlockEntryId(null)
          if (id) {
            useTabStore.getState().updateActiveTab({
              activeView: 'entries',
              selectedEntryId: id,
            })
          }
        }}
      />
    </>
  )
}
