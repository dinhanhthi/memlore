import { useCallback, useEffect, useRef, useState } from 'react'
import { X, ChevronLeft, ChevronRight, PanelsTopLeft, Clock } from 'lucide-react'
import { MediaAttachment } from './MediaAttachment'
import { Button } from '../common/Button'
import { Tooltip } from '../common/Tooltip'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/cn'
import { useUiStore } from '../../stores/uiStore'

/** One slide. `entry` is only present when the carousel is cross-entry (the
 *  Media Library); the editor's attachment strip omits it, which also hides
 *  the metadata footer and the "Open in Entries" button. */
export interface CarouselMediaItem {
  id: string
  fileType: string
  /** Alt / accessible label for the media element. */
  label: string
  entry?: {
    id: string
    title: string
    preview: string
    /** Entry date, unix seconds. */
    date: number
  }
}

interface MediaGalleryCarouselProps {
  media: CarouselMediaItem[]
  initialIndex: number
  onClose: () => void
  /** Switches the active tab to Entries and selects the given entry. Only
   *  rendered when the current item carries `entry`. */
  onOpenInEntries?: (entryId: string) => void
}

/**
 * Carousel opened from a full-page Media Gallery card click and from the
 * editor's attachment strip (image / video tiles).
 *
 * It plays **audio inline** too — `MediaAttachment` already renders
 * `AudioPlayer` for `audio/*`, a controllable `<video>` for `video/*` and an
 * `<img>` for `image/*`, so a single call covers all three. In the gallery the
 * list is the page's already-filtered rows (cross-entry), so navigating ←/→
 * moves across entries and the footer + "Open in Entries" target rebind to
 * whichever entry owns the current media; from the editor the list is a single
 * entry's attachments, carries no `entry` metadata, and both chrome pieces are
 * omitted.
 *
 * Renders as an `absolute inset-0` overlay scoped to a host container rather
 * than the viewport, so it covers only the app's main body — not the titlebar,
 * sidebar or footer. The gallery page supplies its own `relative` wrapper; the
 * editor portals into the layout card (see `BODY_OVERLAY_HOST_ID`). Esc
 * closes, ←/→ navigate, backdrop click closes.
 */
export function MediaGalleryCarousel({
  media,
  initialIndex,
  onClose,
  onOpenInEntries,
}: MediaGalleryCarouselProps) {
  const { t } = useTranslation('editor')
  const [currentIndex, setCurrentIndex] = useState(() =>
    Math.min(initialIndex, Math.max(0, media.length - 1)),
  )

  // If the list empties (e.g. page changed underneath us), close.
  useEffect(() => {
    if (media.length === 0) onClose()
  }, [media.length, onClose])

  const safeIndex = Math.min(currentIndex, Math.max(0, media.length - 1))
  const current = media[safeIndex]

  const goToPrev = useCallback(() => {
    setCurrentIndex((i) => (i > 0 ? i - 1 : i))
  }, [])

  const goToNext = useCallback(() => {
    setCurrentIndex((i) => (i < media.length - 1 ? i + 1 : i))
  }, [media.length])

  // Close animation: reverse the enter (fade + scale out), then unmount once
  // the transition finishes. `closingRef` guards against a double request
  // stacking two timers; reduced motion unmounts immediately with no delay.
  const reducedMotion = useUiStore((s) => s.reducedMotion)
  const [closing, setClosing] = useState(false)
  const closingRef = useRef(false)
  const closeTimerRef = useRef<number | null>(null)
  const requestClose = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    if (reducedMotion) {
      onClose()
      return
    }
    setClosing(true)
    closeTimerRef.current = window.setTimeout(onClose, 200)
  }, [onClose, reducedMotion])
  useEffect(() => {
    return () => {
      if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current)
    }
  }, [])

  // Keyboard navigation.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestClose()
      else if (e.key === 'ArrowLeft') goToPrev()
      else if (e.key === 'ArrowRight') goToNext()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [requestClose, goToPrev, goToNext])

  // Open animation: mount at 0, flip to 1 on the next frame so the backdrop
  // fades and the media scales in. Reduced motion skips straight to the
  // settled state (no transition class either, below).
  const [entered, setEntered] = useState(reducedMotion)
  useEffect(() => {
    if (reducedMotion) return
    const id = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(id)
  }, [reducedMotion])

  if (!current) return null

  // Settled (fully open) only while neither entering nor closing.
  const shown = entered && !closing

  const showNav = media.length > 1
  const isVideo = current.fileType.startsWith('video/')
  const isAudio = current.fileType.startsWith('audio/')
  const entry = current.entry
  // Backdrop click closes. Each region only closes when the click lands
  // directly on the region (target === currentTarget), so clicks on the media,
  // buttons or text never dismiss the dialog.
  const closeIfBackdrop = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) requestClose()
  }

  const overlay = (
    <div
      className={cn(
        'absolute inset-0 z-40 flex flex-col bg-black/90 transition-opacity duration-200 ease-out motion-reduce:transition-none',
        shown ? 'opacity-100' : 'opacity-0',
      )}
      onClick={closeIfBackdrop}
      role="dialog"
      aria-modal="true"
      aria-label={t('carousel.aria')}
    >
      {/* Header — "Open in Entries" (rebinds to the current media's entry) + close.
          Ghost button colours are overridden because the backdrop is always
          dark, even in light theme. */}
      <div className="flex shrink-0 items-center justify-between px-4 py-3">
        {entry && onOpenInEntries ? (
          <Button
            variant="ghost"
            size="sm"
            icon={<PanelsTopLeft className="size-3.5" aria-hidden />}
            onClick={() => onOpenInEntries(entry.id)}
            className="text-white/85 hover:bg-white/10 hover:text-white"
          >
            {t('carousel.open_in_entries')}
          </Button>
        ) : (
          // Spacer so the counter + close button stay right-aligned when the
          // carousel is opened from the editor (no entry metadata).
          <span aria-hidden />
        )}
        <div className="flex items-center gap-3">
          {showNav && (
            <span className="text-2xs text-white/60 tabular-nums">
              {safeIndex + 1} / {media.length}
            </span>
          )}
          <Tooltip content={t('carousel.close_tooltip')}>
            <button
              type="button"
              onClick={requestClose}
              aria-label={t('carousel.close')}
              className="inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-white/80 transition-colors hover:bg-white/10 hover:text-white motion-reduce:transition-none"
            >
              <X className="size-4" />
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Media region — click on empty space here closes the carousel; clicks
          on the media itself do not (target is the media element, not this
          region). `key` forces MediaAttachment to remount + re-resolve the
          blob URL per item. */}
      <div
        className={cn(
          'relative flex min-h-0 flex-1 items-center justify-center px-4 transition-transform duration-200 ease-out motion-reduce:transition-none',
          shown ? 'scale-100' : 'scale-95',
        )}
        onClick={closeIfBackdrop}
      >
        {isAudio ? (
          // Audio gets a wide, prominent stage so the custom AudioPlayer
          // transport + visualizer have room (the image className
          // `w-auto object-contain` would collapse it). The card also gives
          // the player a clear "big container" presence.
          <div className="w-full max-w-2xl rounded-2xl bg-white/5 p-5 ring-1 ring-white/10 backdrop-blur">
            <MediaAttachment
              key={current.id}
              mediaId={current.id}
              alt={current.label}
              className="w-full"
              placeholderVariant="fill"
            />
          </div>
        ) : (
          <MediaAttachment
            key={current.id}
            mediaId={current.id}
            alt={current.label}
            className="max-h-[60vh] w-auto max-w-[80vw] rounded-xl object-contain"
            placeholderVariant="fill"
            videoAutoPlay={isVideo}
          />
        )}

        {showNav && (
          <>
            <button
              type="button"
              className="absolute left-4 z-10 cursor-pointer rounded-full bg-black/60 p-2 text-white transition-opacity hover:opacity-80 disabled:cursor-default disabled:opacity-30"
              onClick={goToPrev}
              disabled={safeIndex === 0}
              aria-label={t('carousel.prev')}
            >
              <ChevronLeft className="size-6" />
            </button>
            <button
              type="button"
              className="absolute right-4 z-10 cursor-pointer rounded-full bg-black/60 p-2 text-white transition-opacity hover:opacity-80 disabled:cursor-default disabled:opacity-30"
              onClick={goToNext}
              disabled={safeIndex === media.length - 1}
              aria-label={t('carousel.next')}
            >
              <ChevronRight className="size-6" />
            </button>
          </>
        )}
      </div>

      {/* Footer — entry metadata for the CURRENT media (updates on navigate).
          Omitted entirely when the items carry no entry (editor strip). */}
      {entry && (
        <div className="shrink-0 px-6 pt-3 pb-5">
          <div className="mx-auto max-w-3xl">
            <div className="truncate text-base font-semibold text-white">
              {entry.title || 'Untitled'}
            </div>
            {entry.preview ? (
              <div className="mt-1.5 line-clamp-2 text-sm text-white/75">{entry.preview}</div>
            ) : null}
            <div className="text-2xs mt-2 flex items-center gap-1 text-white/60 tabular-nums">
              <Clock className="size-3" aria-hidden="true" />
              {new Date(entry.date * 1000).toLocaleDateString()}
            </div>
          </div>
        </div>
      )}
    </div>
  )

  return overlay
}
