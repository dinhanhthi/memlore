import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Settings } from 'lucide-react'
import { useAllMedia } from '../../hooks/useAllMedia'
import type { MediaKind } from '../../hooks/useAllMedia'
import { useUpdateActiveTab } from '../../hooks/useActiveTab'
import { RadioOptionPill } from '../common/RadioOptionPill'
import { Select } from '../common/Select'
import { Tooltip } from '../common/Tooltip'
import { ensureMediaCached } from './mediaCache'
import { Paginator } from '../common/Paginator'
import MediaGallerySkeleton from './MediaGallerySkeleton'
import { SecondLockPromptModal } from '../common/SecondLockPromptModal'
import { MediaGalleryCell } from './MediaGalleryCell'
import { MediaGalleryCarousel, type CarouselMediaItem } from './MediaGalleryCarousel'
import { RestoredScroll } from '../common/RestoredScroll'
import { PAGE_SIZE_SELECT_OPTIONS } from './galleryPageSize'
import { cn } from '../../lib/cn'
import { useUiStore } from '../../stores/uiStore'
import type { GalleryMediaRow } from '../../lib/tauri'

type FilterValue = 'image' | 'video' | 'audio' | 'all'

const FILTER_VALUES: FilterValue[] = ['all', 'image', 'video', 'audio']

/** i18n key suffix for the empty state of the active kind filter. */
function emptyStateKey(kind: MediaKind): string {
  return kind ?? 'all'
}

/**
 * Full-page Media Gallery — responsive rich-card grid (type badge + entry
 * footer overlay). Shares data loading / prefetch / second-lock with the
 * 2-panel `MediaGalleryView`, but drops the "Per row" control in favour of
 * a fixed responsive breakpoint grid and uses a wider header layout.
 *
 * Cell click opens `MediaGalleryCarousel` over the current page's media
 * (cross-entry: each media may belong to a different entry). "Open in
 * Entries" inside the carousel switches this tab to Entries with the current
 * media's source entry selected.
 */
export function MediaGalleryFullView() {
  const { t } = useTranslation('palette')
  const { t: tNav } = useTranslation('nav')
  const [kind, setKind] = useState<MediaKind>(null)
  const [secondLockPromptOpen, setSecondLockPromptOpen] = useState(false)
  const [carousel, setCarousel] = useState<{ index: number } | null>(null)
  const { media, total, totalPages, page, setPage, isLoading, error } = useAllMedia({ kind })
  const updateActiveTab = useUpdateActiveTab()
  const mediaPageSize = useUiStore((s) => s.mediaPageSize)
  const setMediaPageSize = useUiStore((s) => s.setMediaPageSize)
  const isClay = useUiStore((s) => s.designSystem) === 'clay'

  const openMediaSettings = useCallback(() => {
    updateActiveTab({ activeView: 'settings', selectedEntryId: null, settingsCategory: 'media' })
  }, [updateActiveTab])

  const openCarousel = useCallback(
    (row: GalleryMediaRow) => {
      const index = media.findIndex((m) => m.id === row.id)
      if (index !== -1) setCarousel({ index })
    },
    [media],
  )

  const handleOpenInEntries = useCallback(
    (id: string) => {
      updateActiveTab({ activeView: 'entries', selectedEntryId: id })
      setCarousel(null)
    },
    [updateActiveTab],
  )

  // Carousel slides — entry metadata rides along so the footer + "Open in
  // Entries" rebind as the user navigates across entries.
  const carouselItems = useMemo<CarouselMediaItem[]>(
    () =>
      media.map((row) => ({
        id: row.id,
        fileType: row.fileType,
        label: row.entryTitle || 'Untitled',
        entry: {
          id: row.entryId,
          title: row.entryTitle,
          preview: row.entryPreview,
          date: row.entryDate,
        },
      })),
    [media],
  )

  // Auto-download trigger for every cell on the current page. Same
  // fingerprint + skip-audio logic as MediaGalleryView — keep them in
  // lockstep so full-page never regresses to "Tap to download".
  const mediaIdsKey = media.map((r) => r.id).join(',')
  useEffect(() => {
    for (const row of media) {
      if (row.fileType.startsWith('audio/')) continue
      void ensureMediaCached(row.id, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaIdsKey])

  return (
    <div
      data-testid="media-gallery-full-view"
      className={cn(
        'relative flex h-full flex-col',
        isClay &&
          'xj-main-panel bg-selected-tab overflow-hidden rounded-2xl shadow-(--shadow-panel)',
      )}
    >
      {/* Header — transparent so it shares one continuous background with the
          grid body. No opaque bg / no -mb-px seam fix is needed: header and
          body share the same backdrop, so there is no colour boundary to bleed. */}
      <div className="relative z-30 flex shrink-0 items-start justify-between gap-4 p-4">
        <div className="min-w-0">
          <h1 className="font-title text-fg text-2xl font-extrabold">
            {tNav('media_gallery.title')}
          </h1>
          <p className="text-fg-muted text-sm">
            {tNav('media_gallery.subtitle', { count: total })}
          </p>
        </div>
        <div className="flex items-center gap-3 self-center">
          <div
            role="radiogroup"
            aria-label={tNav('media_gallery.kind_aria')}
            className="flex flex-wrap gap-2"
          >
            {FILTER_VALUES.map((value) => (
              <RadioOptionPill
                key={value}
                selected={(kind ?? 'all') === value}
                onClick={() => setKind(value === 'all' ? null : value)}
                className="px-3 py-1 text-xs"
                label={tNav(`media_gallery.kind.${value}`)}
              />
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-fg-muted text-xs whitespace-nowrap">
              {tNav('media_gallery.per_page')}
            </span>
            <Select
              value={String(mediaPageSize)}
              onChange={(v) => setMediaPageSize(Number(v))}
              options={PAGE_SIZE_SELECT_OPTIONS}
              aria-label={tNav('media_gallery.per_page_aria')}
              className="w-auto shrink-0 px-2.5 py-1.5 text-xs"
            />
          </div>
          <Tooltip content={t('settings.media', { defaultValue: 'Settings → Media' })}>
            <button
              type="button"
              onClick={openMediaSettings}
              aria-label={t('settings.media', { defaultValue: 'Settings → Media' })}
              data-testid="media-library-settings-button"
              className="text-fg-muted hover:bg-elevated hover:text-fg inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors motion-reduce:transition-none"
            >
              <Settings className="size-4" />
            </button>
          </Tooltip>
        </div>
      </div>

      {error && (
        <p className="text-fg-muted shrink-0 px-8 text-sm" role="alert">
          {error}
        </p>
      )}

      {isLoading ? (
        <MediaGallerySkeleton variant="rich" />
      ) : (
        <RestoredScroll
          view="media"
          sub="full"
          ready={!isLoading}
          className="flex flex-1 flex-col overflow-y-auto p-4 pt-0"
        >
          {!error && media.length === 0 ? (
            <p className="text-fg-muted mt-8 text-center text-sm">
              {tNav(`media_gallery.empty.${emptyStateKey(kind)}`)}
            </p>
          ) : (
            !error && (
              <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
                {media.map((row) => (
                  <MediaGalleryCell
                    key={row.id}
                    row={row}
                    compact={false}
                    variant="rich"
                    onSelect={() => openCarousel(row)}
                    onLockedClick={() => setSecondLockPromptOpen(true)}
                  />
                ))}
              </div>
            )
          )}
        </RestoredScroll>
      )}

      <Paginator
        currentPage={page}
        totalPages={totalPages}
        onPageChange={setPage}
        itemLabel="media"
      />
      <SecondLockPromptModal
        open={secondLockPromptOpen}
        onClose={() => setSecondLockPromptOpen(false)}
        title={tNav('media_gallery.unlock_title')}
        description={tNav('media_gallery.unlock_description')}
        mode="unlock-session"
        onVerified={() => {
          setSecondLockPromptOpen(false)
        }}
      />
      {carousel !== null && media.length > 0 && (
        <MediaGalleryCarousel
          media={carouselItems}
          initialIndex={carousel.index}
          onClose={() => setCarousel(null)}
          onOpenInEntries={handleOpenInEntries}
        />
      )}
    </div>
  )
}
