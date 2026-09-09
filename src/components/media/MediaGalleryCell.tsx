import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  PlayCircle,
  Image as ImageIcon,
  Video,
  Mic,
  LockKeyhole,
  Clock,
  ZoomIn,
} from 'lucide-react'
import type { GalleryMediaRow } from '../../lib/tauri'
import { MediaAttachment } from './MediaAttachment'
import { peekCachedMedia } from './mediaCache'
import { cn } from '../../lib/cn'

/**
 * Format a positive number of seconds as `m:ss`. Returns an empty string
 * for null / non-finite / negative inputs so callers can substitute a
 * fallback label without re-checking the type.
 *
 * Kept in sync with the same helper in `AttachmentStrip.tsx` — the two
 * audio thumbnails share this duration formatting so the look is
 * consistent across the editor strip and the Media Gallery.
 */
function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return ''
  const total = Math.round(seconds)
  const mm = Math.floor(total / 60)
  const ss = total % 60
  return `${mm}:${ss.toString().padStart(2, '0')}`
}

/**
 * Gate a heavy child render on viewport visibility via IntersectionObserver,
 * with an extra one-frame delay before mounting visible children.
 *
 * Why the IntersectionObserver: rendering 20 MediaAttachment cells
 * simultaneously fires 20 parallel Tauri IPC reads + 20 JPEG decodes +
 * 20 blob URL paints. Below-the-fold cells defer their mount until they
 * approach the viewport (rootMargin pre-loads them), cutting the storm
 * roughly in half.
 *
 * Why the rAF defer: even with the observer in place, all above-the-fold
 * cells fire `isIntersecting=true` on the same microtask after the first
 * commit — synchronously bunched, which still blocks WebKit's compositor
 * for >1s on tab switches into the gallery. Scheduling `setVisible(true)`
 * via `requestAnimationFrame` lets the placeholder grid paint first, then
 * the IPC/decode storm kicks off on the next frame, so the visible page
 * swap stays under one frame even on a cache-hit re-entry.
 *
 * Once a cell becomes visible we keep its child mounted; scrolling back up
 * doesn't re-trigger IPC.
 */
export function LazyMount({
  children,
  placeholder,
  rootMargin = '200px',
  initialVisible = false,
}: {
  children: React.ReactNode
  placeholder: React.ReactNode
  rootMargin?: string
  /**
   * Skip the IntersectionObserver + rAF placeholder phase and mount the
   * child synchronously on the very first render. Used by the gallery on
   * tab re-entry: if the row's thumbnail blob is already in `mediaCache`,
   * `MediaAttachment` will set `<img src>` synchronously on first render,
   * and we want zero placeholder flash between cached cells and the image.
   */
  initialVisible?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(initialVisible)
  useEffect(() => {
    if (visible) return
    const el = ref.current
    if (!el) return
    let rafId = 0
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect()
          // Yield one frame so the placeholder paints before MediaAttachment
          // mount triggers IPC + decode.
          rafId = window.requestAnimationFrame(() => setVisible(true))
        }
      },
      { rootMargin },
    )
    io.observe(el)
    return () => {
      io.disconnect()
      if (rafId) window.cancelAnimationFrame(rafId)
    }
  }, [visible, rootMargin])
  return (
    <div ref={ref} className="h-full w-full">
      {visible ? children : placeholder}
    </div>
  )
}

export interface MediaGalleryCellProps {
  row: GalleryMediaRow
  /** Icon/label scale — mirrors the old `cols > 2` / `cols <= 2` branches. */
  compact: boolean
  /** 'grid' = current 2-panel cell (no chrome). 'rich' = badge + footer overlay. */
  variant: 'grid' | 'rich'
  onSelect: () => void
  onLockedClick: () => void
}

/**
 * Single gallery cell — shared by the 2-panel grid (`variant="grid"`) and the
 * full-page gallery (`variant="rich"`). Click navigates / opens entry via
 * `onSelect`; locked placeholders route through `onLockedClick`.
 *
 * Cell uses role="button" + tabIndex instead of `<button>` because
 * MediaAttachment itself renders a `<button>` for cloud-badge tap-to-
 * download; nested `<button>` elements are invalid HTML and break
 * keyboard / screen-reader navigation.
 */
export function MediaGalleryCell({
  row,
  compact,
  variant,
  onSelect,
  onLockedClick,
}: MediaGalleryCellProps) {
  const { t } = useTranslation('nav')
  const isLockedPlaceholder = row.fileType === 'locked/placeholder'
  const isVideo = row.fileType.startsWith('video/')
  const isAudio = row.fileType.startsWith('audio/')
  // Cache-hit fast path: blob is already a live URL in
  // mediaCache, so `<img>` will decode in <50ms once the
  // browser sees it. Skip native lazy-loading for these —
  // it forces a 0.5–1s "wait for viewport check" frame
  // even when the bytes are sitting in RAM, which is what
  // made tab re-entry feel like it was reloading the page.
  //
  // Cache miss: keep native lazy on so the cold-paint
  // storm stays staggered and the sidebar click into the
  // gallery doesn't block on N parallel decodes. LazyMount
  // already defers off-viewport cells; the two together
  // give us "instant on hit, smooth on miss".
  const cacheHit = peekCachedMedia(row.id, true) !== null

  const dateLabel = new Date(row.entryDate * 1000).toLocaleDateString()
  // Empty when the backend has no duration (e.g. audio metadata not yet
  // probed). We render the duration label only when present so audio cells
  // never show a placeholder "--:--".
  const durationLabel = formatDuration(row.durationSeconds)
  // Locked placeholders must not expose entryTitle via a11y —
  // title is second-lock protected content (footer already redacts).
  const ariaLabel = isLockedPlaceholder
    ? t('media_gallery.unlock_title')
    : variant === 'rich'
      ? t('media_gallery.cell_open_titled', {
          title: row.entryTitle || t('media_gallery.untitled'),
          date: dateLabel,
        })
      : t('media_gallery.cell_open', { date: dateLabel })

  // Rich-variant type badge — labels/icons derived from fileType.
  // `text-white` on `bg-black/55` is intentional for photo overlays
  // (not a text-fg-inverse case).
  const richType = isLockedPlaceholder
    ? ({ label: t('media_gallery.badge.locked'), Icon: LockKeyhole } as const)
    : isVideo
      ? ({ label: t('media_gallery.badge.video'), Icon: Video } as const)
      : isAudio
        ? ({ label: t('media_gallery.badge.audio'), Icon: Mic } as const)
        : ({ label: t('media_gallery.badge.image'), Icon: ImageIcon } as const)

  const handleActivate = () => {
    if (isLockedPlaceholder) onLockedClick()
    else onSelect()
  }

  // Cell fill is `bg-panel-2` — one step DARKER than the page it sits on. Both
  // gallery hosts render inside the app card's `bg-elevated` shell (their own
  // column is transparent in dark), so a `bg-elevated` cell was invisible until
  // an image decoded. panel-2 is a consistent one-step drop in Deep (#141414 on
  // #1c1c1c) and Soft (#1c1c1c on #242424), and reads as a recessed media well.
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      onClick={handleActivate}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          handleActivate()
        }
      }}
      className="group border-border-default bg-panel-2 relative aspect-square cursor-pointer overflow-hidden rounded-xl border transition-shadow hover:shadow-lg focus:outline-none"
    >
      {isLockedPlaceholder ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onLockedClick()
          }}
          className="text-fg-muted flex h-full w-full flex-col items-center justify-center gap-2"
          aria-label={t('media_gallery.unlock_title')}
        >
          <LockKeyhole
            className={cn({
              'size-6': compact,
              'size-8': !compact,
            })}
            strokeWidth={1.75}
          />
          <span className="text-xs font-semibold">{t('media_gallery.badge.locked')}</span>
        </button>
      ) : isAudio ? (
        // Mirror the AttachmentStrip's audio tile: a mic-icon
        // square with a duration label. Click bubbles up to
        // the outer role="button" wrapper and navigates to
        // the source entry — gallery cells are entry-navigation
        // targets, not inline players. To actually listen the
        // user opens the entry and clicks the strip tile,
        // which launches the playback modal with speed
        // controls.
        <div
          data-testid={`audio-cell-${row.id}`}
          className="bg-accent-soft text-accent-text flex h-full w-full flex-col items-center justify-center gap-1.5"
        >
          <Mic
            className={cn({
              'size-6': compact,
              'size-8': !compact,
            })}
            aria-hidden="true"
          />
          {durationLabel && (
            <span
              className={cn('font-mono leading-none font-medium tabular-nums', {
                'text-xs': compact,
                'text-sm': !compact,
              })}
            >
              {durationLabel}
            </span>
          )}
        </div>
      ) : (
        <>
          <LazyMount
            // We deliberately do NOT pass initialVisible=true
            // even on cache hit. Doing so packs all N
            // MediaAttachment mounts (useRef + useEffect +
            // peekCachedStatus per cell) into the same React
            // commit as the sidebar click that switched to
            // this view, blocking main thread ~1s. Keeping
            // the IO + rAF defer splits mount cost into a
            // separate frame, so the click→panel-switch
            // stays cheap. The placeholder is `bg-panel-2`
            // (same as the cell wrapper), so the deferred
            // mount produces no visible flash on cache hit.
            placeholder={
              <div
                aria-hidden="true"
                className="bg-panel-2 text-fg-muted/50 flex h-full w-full items-center justify-center motion-safe:animate-pulse"
              >
                {/* Icon follows this cell's real fileType (image / video /
                    audio) — the deferred mount then swaps like-for-like
                    instead of turning an "image" placeholder into a video. */}
                <richType.Icon className="size-8" strokeWidth={1.5} />
              </div>
            }
          >
            <MediaAttachment
              mediaId={row.id}
              className="h-full w-full object-cover"
              previewOnly={isVideo}
              // Eager decode on cache hit (bytes in RAM,
              // ~50ms), native lazy on cache miss so a
              // page of cold cells doesn't block the
              // sidebar-click → gallery transition on
              // N parallel decodes.
              lazy={!cacheHit}
              useThumbnail={true}
              // Cloud-only placeholders need to fill the
              // aspect-square cell, not collapse to a
              // 50% inline-style box.
              placeholderVariant="fill"
              // No `skeletonClassName` override: MediaAttachment's
              // own default in-place fill is already `bg-panel-2`,
              // which is exactly the cell wrapper's colour now, so
              // every skeleton layer shares one background and the
              // fill behind a decoded image can't show through
              // lighter than the card.
              skeletonIcon
            />
          </LazyMount>
          {isVideo && (
            <span
              data-testid={`video-play-overlay-${row.id}`}
              aria-hidden="true"
              className="pointer-events-none absolute top-2 right-2 flex items-center justify-center rounded-full bg-black/55 p-1 text-white"
            >
              <PlayCircle className="size-5" strokeWidth={1.75} />
            </span>
          )}
        </>
      )}

      {/* Hover affordance: a centered zoom badge over a light scrim that
          fades in on hover/focus, signalling the card opens a larger viewer.
          Rich variant only (its click opens the carousel = "enlarge"); the
          grid variant navigates to the entry, where a zoom cue would mislead.
          Skipped for locked placeholders (they open an unlock prompt).
          `pointer-events-none` so the click still lands on the cell. */}
      {variant === 'rich' && !isLockedPlaceholder && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-black/0 opacity-0 transition-opacity duration-200 group-hover:bg-black/25 group-hover:opacity-100 motion-reduce:transition-none"
        >
          <span className="flex size-11 items-center justify-center rounded-full bg-black/60 text-white shadow-lg backdrop-blur-sm">
            <ZoomIn className="size-5" strokeWidth={2} aria-hidden="true" />
          </span>
        </div>
      )}

      {/* Rich full-page chrome: type badge + entry footer. Grid
          variant stays unchanged (no badge / no footer). Locked
          placeholders get the badge only — backend already blanks
          title/preview, but we skip the footer as belt-and-braces. */}
      {variant === 'rich' && (
        <>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-2 left-2 z-10 flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-xs font-medium text-white backdrop-blur-sm"
          >
            <richType.Icon className="size-3.5" aria-hidden="true" />
            {richType.label}
          </span>
          {!isLockedPlaceholder && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col gap-1.5 bg-linear-to-t from-black/85 via-black/55 to-transparent px-3 pt-8 pb-2.5"
            >
              <div className="truncate text-base font-semibold text-white">
                {row.entryTitle || 'Untitled'}
              </div>
              {row.entryPreview ? (
                <div className="line-clamp-2 text-xs text-white/75">{row.entryPreview}</div>
              ) : null}
              <div className="text-2xs flex items-center gap-1 text-white/60 tabular-nums">
                <Clock className="size-3" aria-hidden="true" />
                {dateLabel}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
