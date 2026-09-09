import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, LockKeyhole } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { listAllMediaPaged, type GalleryMediaRow } from '../../../lib/tauri'
import { useInvisibleLockStore } from '../../../stores/invisibleLockStore'
import { useSecondLockStore } from '../../../stores/secondLockStore'
import { useTabStore } from '../../../stores/tabStore'
import type { PagedResult } from '../../../types/pagination'
import { Button } from '../../common/Button'
import { SecondLockPromptModal } from '../../common/SecondLockPromptModal'
import { MediaAttachment } from '../../media/MediaAttachment'
import { DashboardCard } from '../DashboardCard'

export function PhotosCard() {
  const { t } = useTranslation('dashboard')
  const activeVaultId = useInvisibleLockStore((s) => s.activeVaultId)
  const lockedView = useSecondLockStore((s) => s.lockedView())
  const [unlockEntryId, setUnlockEntryId] = useState<string | null>(null)

  const query = useQuery<PagedResult<GalleryMediaRow>>({
    queryKey: ['media', { kind: 'image', page: 1, pageSize: 3, lockedView, activeVaultId }],
    queryFn: () => listAllMediaPaged('image', 1, lockedView, activeVaultId, 3),
  })

  const items = (query.data?.items ?? []).slice(0, 3)
  const error = query.error ? String(query.error) : null

  return (
    <>
      <DashboardCard
        title={t('cards.photos')}
        action={
          <Button
            variant="ghost"
            size="xs"
            icon={<ArrowRight className="size-4" />}
            onClick={() =>
              useTabStore.getState().updateActiveTab({
                activeView: 'media',
                selectedEntryId: null,
              })
            }
          >
            {t('actions.media')}
          </Button>
        }
      >
        {query.isPending ? (
          <div className="grid h-full min-h-0 grid-cols-3 gap-2">
            {[0, 1, 2].map((key) => (
              <div
                key={key}
                className="bg-panel-2 aspect-square w-full rounded-lg motion-safe:animate-pulse"
              />
            ))}
          </div>
        ) : error ? (
          <p className="text-fg-muted text-sm" role="alert">
            {error}
          </p>
        ) : items.length === 0 ? (
          <p className="text-fg-muted text-sm">{t('photos.empty')}</p>
        ) : (
          <div className="grid h-full min-h-0 grid-cols-3 gap-2">
            {items.map((row) => {
              const isLockedPlaceholder = row.fileType === 'locked/placeholder'
              const activate = () => {
                if (isLockedPlaceholder) {
                  setUnlockEntryId(row.entryId)
                  return
                }
                useTabStore.getState().updateActiveTab({
                  activeView: 'entries',
                  selectedEntryId: row.entryId,
                })
              }
              return (
                <div
                  key={row.id}
                  role="button"
                  tabIndex={0}
                  className="min-h-0"
                  onClick={activate}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      activate()
                    }
                  }}
                >
                  {isLockedPlaceholder ? (
                    <div className="bg-panel-2 text-fg-muted flex aspect-square w-full items-center justify-center overflow-hidden rounded-lg">
                      <LockKeyhole className="size-8" />
                    </div>
                  ) : (
                    <div className="aspect-square w-full overflow-hidden rounded-lg">
                      <MediaAttachment
                        mediaId={row.id}
                        alt={row.entryTitle ?? ''}
                        previewOnly
                        useThumbnail
                        lazy
                        className="size-full object-cover"
                      />
                    </div>
                  )}
                </div>
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
