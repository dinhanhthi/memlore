import { useState, type MouseEvent } from 'react'
import { ArrowRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useOnThisDay } from '../../../hooks/useOnThisDay'
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

export function OnThisDayCard() {
  const { t } = useTranslation('dashboard')
  const today = new Date()
  const { groups, isLoading, error } = useOnThisDay([
    { month: today.getMonth() + 1, day: today.getDate() },
  ])
  const currentYear = today.getFullYear()
  const pastEntries = (groups[0]?.entries ?? [])
    .filter((entry) => new Date(entry.entry_date * 1000).getFullYear() !== currentYear)
    .slice(0, 3)
  const [unlockEntryId, setUnlockEntryId] = useState<string | null>(null)

  return (
    <>
      <DashboardCard
        title={t('cards.on_this_day')}
        action={
          <Button
            variant="ghost"
            size="xs"
            icon={<ArrowRight className="size-4" />}
            onClick={() =>
              useTabStore.getState().updateActiveTab({
                activeView: 'onthisday',
                selectedEntryId: null,
              })
            }
          >
            {t('actions.onthisday')}
          </Button>
        }
      >
        {isLoading ? (
          <div className="flex flex-col gap-2">
            {[0, 1, 2].map((key) => (
              <div key={key} className="bg-panel-2 h-5 rounded-md motion-safe:animate-pulse" />
            ))}
          </div>
        ) : error ? (
          <p className="text-fg-muted text-sm" role="alert">
            {error}
          </p>
        ) : pastEntries.length === 0 ? (
          <p className="text-fg-muted text-sm">{t('on_this_day.empty')}</p>
        ) : (
          pastEntries.map((entry) => {
            const year = new Date(entry.entry_date * 1000).getFullYear()
            const isCoveredLocked =
              entry.is_locked &&
              entry.title === null &&
              entry.preview_text === null &&
              entry.content_text === null
            return (
              <button
                key={entry.id}
                type="button"
                className="hover:bg-panel-2 flex w-full items-baseline justify-between gap-2 rounded-md px-1 py-1.5 text-left"
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
                <span className="text-fg-muted text-2xs shrink-0 font-mono">{year}</span>
                <span className="text-fg min-w-0 truncate text-sm">
                  {isCoveredLocked
                    ? t('entry_card.locked_entry', { ns: 'editor' })
                    : entry.title || t('media_gallery.untitled', { ns: 'nav' })}
                </span>
              </button>
            )
          })
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
