import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAllMedia } from '../../hooks/useAllMedia'
import type { MediaKind } from '../../hooks/useAllMedia'
import { useUpdateActiveTab } from '../../hooks/useActiveTab'
import { RadioOptionPill } from '../common/RadioOptionPill'
import { Select } from '../common/Select'
import { ensureMediaCached } from './mediaCache'
import { Paginator } from '../common/Paginator'
import { cn } from '../../lib/cn'
import MediaGallerySkeleton from './MediaGallerySkeleton'
import { SecondLockPromptModal } from '../common/SecondLockPromptModal'
import { MediaGalleryCell } from './MediaGalleryCell'
import { PAGE_SIZE_SELECT_OPTIONS } from './galleryPageSize'
import { RestoredScroll } from '../common/RestoredScroll'
import { SecondPanel } from '../layout/SecondPanel'
import { useUiStore } from '../../stores/uiStore'

type FilterValue = 'image' | 'video' | 'audio' | 'all'

const COLS_OPTIONS = [4, 3, 2, 1] as const
type ColsOption = (typeof COLS_OPTIONS)[number]

const COLS_SELECT_OPTIONS = COLS_OPTIONS.map((n) => ({ value: String(n), label: String(n) }))

const colsClass: Record<ColsOption, string> = {
  4: 'grid-cols-4',
  3: 'grid-cols-3',
  2: 'grid-cols-2',
  1: 'grid-cols-1',
}

const FILTER_VALUES: FilterValue[] = ['all', 'image', 'video', 'audio']

/** i18n key suffix for the empty state of the active kind filter. */
function emptyStateKey(kind: MediaKind): string {
  return kind ?? 'all'
}

/**
 * Cross-entry Media Gallery — responsive grid of every media row across every
 * journal, newest first. Each cell reuses `MediaAttachment` for thumbnail /
 * cloud-badge / tap-to-download behavior (or `AudioPlayer` for audio rows).
 * Clicking a cell navigates the active tab to the source entry. Pagination is
 * driven by the `<Paginator>` component at the bottom of the view.
 */
export function MediaGalleryView() {
  const { t } = useTranslation('nav')
  const [kind, setKind] = useState<MediaKind>(null)
  const [cols, setCols] = useState<ColsOption>(4)
  const [secondLockPromptOpen, setSecondLockPromptOpen] = useState(false)
  const { media, totalPages, page, setPage, isLoading, error } = useAllMedia({ kind })
  const updateActiveTab = useUpdateActiveTab()
  const mediaPageSize = useUiStore((s) => s.mediaPageSize)
  const setMediaPageSize = useUiStore((s) => s.setMediaPageSize)

  // Auto-download trigger for every cell on the current page. Re-runs
  // whenever the page-of-rows actually changes (use the list of ids as
  // a fingerprint so a new array reference with the same items doesn't
  // re-trigger). `ensureMediaCached` is idempotent + deduped — calling
  // it for rows already on disk is a no-op. LazyMount may hold off the
  // visual mount until the cell scrolls into view, but we still want
  // the bytes downloaded eagerly so the user never sees "Tap to
  // download" by scrolling.
  const mediaIdsKey = media.map((r) => r.id).join(',')
  useEffect(() => {
    for (const row of media) {
      // Audio rows have no thumbnail file — the gallery renders the
      // inline AudioPlayer for those, which already triggers its own
      // full-bytes resolve when the user clicks play. Skip here.
      if (row.fileType.startsWith('audio/')) continue
      void ensureMediaCached(row.id, true)
    }
    // We deliberately depend on `mediaIdsKey` (a string fingerprint)
    // rather than `media` (an array reference) — TanStack Query hands
    // us a fresh array on every refetch even when the row contents
    // are identical, which would otherwise re-fire the loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaIdsKey])

  return (
    <SecondPanel data-testid="media-gallery-view" className="bg-panel-2">
      {/* Shrink-0 header section */}
      <div className="shrink-0 p-4">
        <h1 className="font-title text-fg mb-4 text-2xl font-extrabold">
          {t('media_gallery.panel_title')}
        </h1>

        {/* Kind filter — same pills as Lookback's date-range picker. */}
        <div
          role="radiogroup"
          aria-label={t('media_gallery.kind_aria')}
          className="mb-3 flex flex-wrap gap-2"
        >
          {FILTER_VALUES.map((value) => (
            <RadioOptionPill
              key={value}
              selected={(kind ?? 'all') === value}
              onClick={() => setKind(value === 'all' ? null : value)}
              className="px-3 py-1 text-xs"
              label={t(`media_gallery.kind.${value}`)}
            />
          ))}
        </div>

        {/* Grid controls — column count + page size share one wrap-tolerant
            row so the narrow 2-panel column never overflows. */}
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex items-center gap-1.5">
            <span className="text-fg-muted text-xs whitespace-nowrap">
              {t('media_gallery.per_row')}
            </span>
            <Select
              value={String(cols)}
              onChange={(v) => setCols(Number(v) as ColsOption)}
              options={COLS_SELECT_OPTIONS}
              aria-label={t('media_gallery.per_row_aria')}
              className="text-2xs w-auto shrink-0 gap-1 rounded-lg px-2 py-1 [&_svg]:size-3"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-fg-muted text-xs whitespace-nowrap">
              {t('media_gallery.per_page')}
            </span>
            <Select
              value={String(mediaPageSize)}
              onChange={(v) => setMediaPageSize(Number(v))}
              options={PAGE_SIZE_SELECT_OPTIONS}
              aria-label={t('media_gallery.per_page_aria')}
              className="text-2xs w-auto shrink-0 gap-1 rounded-lg px-2 py-1 [&_svg]:size-3"
            />
          </div>
        </div>

        {error && (
          <p className="text-fg-muted mb-3 text-sm" role="alert">
            {error}
          </p>
        )}
      </div>

      {/* Scrollable grid area — skeleton replaces this section during first load */}
      {isLoading ? (
        <MediaGallerySkeleton cols={cols} />
      ) : (
        <RestoredScroll
          view="media"
          ready={!isLoading}
          className="flex flex-1 flex-col overflow-y-auto p-4 pt-0"
        >
          {!error && media.length === 0 ? (
            <p className="text-fg-muted mt-8 text-center text-sm">
              {t(`media_gallery.empty.${emptyStateKey(kind)}`)}
            </p>
          ) : (
            !error && (
              <div className={cn('grid gap-2', colsClass[cols])}>
                {media.map((row) => (
                  <MediaGalleryCell
                    key={row.id}
                    row={row}
                    compact={cols > 2}
                    variant="grid"
                    onSelect={() => updateActiveTab({ selectedEntryId: row.entryId })}
                    onLockedClick={() => setSecondLockPromptOpen(true)}
                  />
                ))}
              </div>
            )
          )}
        </RestoredScroll>
      )}

      {/* Paginator — sticky bottom, spans full width */}
      <Paginator
        currentPage={page}
        totalPages={totalPages}
        onPageChange={setPage}
        itemLabel="media"
      />
      <SecondLockPromptModal
        open={secondLockPromptOpen}
        onClose={() => setSecondLockPromptOpen(false)}
        title={t('media_gallery.unlock_title')}
        description={t('media_gallery.unlock_description')}
        mode="unlock-session"
        onVerified={() => {
          setSecondLockPromptOpen(false)
        }}
      />
    </SecondPanel>
  )
}
