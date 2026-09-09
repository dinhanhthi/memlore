import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown, Cloud, ImageIcon, Music } from 'lucide-react'
import { getMediaStatus, resolveMedia, type MediaStatus } from '../../lib/tauri'
import { AudioPlayer } from './AudioPlayer'
import { cn } from '../../lib/cn'
import { formatBytes } from '../../lib/numbers'
import {
  clearEnsureFailureFor,
  ensureMediaCached,
  peekCachedMedia,
  peekCachedStatus,
  resolveCachedMedia,
  type CachedMedia,
} from './mediaCache'

interface MediaAttachmentProps {
  /** The `media_id` UUID from the database. */
  mediaId: string
  /** Alt text for the resolved image. */
  alt?: string
  /** Optional CSS class for the wrapper element. */
  className?: string
  /**
   * Render videos as a static poster `<img>` instead of a `<video controls>`
   * widget. Used by the Media Gallery so the cell stays a uniform clickable
   * navigation target — interactive video controls inside a `role="button"`
   * cell would steal clicks from the navigate handler.
   */
  previewOnly?: boolean
  /**
   * When `true`, the resolved `<img>` uses `loading="lazy"` so off-screen
   * thumbnails are not decoded until they enter the viewport. Defaults to
   * `false` (eager) to keep the editor's in-view images loading immediately.
   */
  lazy?: boolean
  /**
   * When true, the initial render reads thumbnail bytes (smaller, faster
   * decode). Defaults to false; editor and lightbox should keep the default.
   */
  useThumbnail?: boolean
  /**
   * Optional override for the loading-skeleton background class. The default
   * `bg-panel-2` reads as a soft contrast against the editor canvas and is
   * also what the Media Gallery cell wrapper uses, so gallery callers need no
   * override. Only pass a value when the host surface is something else —
   * matching it here keeps every skeleton layer one colour instead of
   * flashing a differently-tinted gray between them.
   */
  skeletonClassName?: string
  /**
   * When true, the loading skeleton renders a centered image icon as a
   * visual placeholder so the empty box is recognizable as "an image is
   * loading here" — used by the editor's inline image node. Defaults to
   * false so other callers (e.g. the gallery, which already overlays its
   * own grid-wide skeleton) keep a clean empty skeleton.
   */
  skeletonIcon?: boolean
  /**
   * Layout variant for the cloud / unavailable placeholder.
   *
   * - `'inline'` (default): editor inline image. Fills the media node's
   *   box so a separated-line clip spans the editor column; a floated
   *   left/right node keeps its float width (the placeholder just fills
   *   that box). `.media-tap-placeholder` opts out of Clean's
   *   corner-radius sweep so `rounded-xl` stays small at every setting.
   * - `'compact'`: 64×64 attachment-strip cell. Tight 2-line layout with
   *   a small icon and a micro-label.
   * - `'fill'`: gallery cell / lightbox. Fills the parent cell exactly
   *   so the placeholder occupies the same box the eventual image will.
   */
  placeholderVariant?: 'inline' | 'compact' | 'fill'
  /**
   * When true, the rendered `<video>` element (only when `previewOnly` is
   * false) auto-plays as soon as it has enough frames. Used by the
   * MediaLightbox so a video opens already playing — matches the user's
   * intent (they just clicked the Play hover icon to enter the lightbox).
   * Has no effect on images or audio.
   */
  videoAutoPlay?: boolean
}

/**
 * DESIGN-TIME FLAG — when true, every loaded image inside the editor
 * (and anywhere else that uses MediaAttachment) is replaced by its
 * loading skeleton so the skeleton style can be inspected live in the
 * DevTools against real, dimensioned content. Remove (or flip back to
 * false) before committing.
 */
const FORCE_SKELETON_FOR_DESIGN = false

/**
 * DESIGN-TIME FLAG — when true, every inline image is replaced by the
 * "tap to download" cloud placeholder so the placeholder style can be
 * inspected live in DevTools against real, dimensioned content. Remove
 * (or flip back to false) before committing.
 */
const FORCE_TAP_TO_DOWNLOAD_FOR_DESIGN = false

interface InitialState {
  status: MediaStatus | null
  fullSrc: string | null
}

/**
 * Compute the initial render state synchronously from the module-level
 * media cache. On a cache hit (e.g. revisiting an entry after switching
 * away), `<img src>` is set on the very first render — no skeleton
 * flash, no Tauri IPC round-trip. On a miss we fall back to the
 * cached-status-only path so the skeleton at least renders with the
 * correct aspect-ratio.
 */
function initialFromCache(mediaId: string, useThumbnail: boolean): InitialState {
  const hit = peekCachedMedia(mediaId, useThumbnail)
  if (hit) return { status: hit.status, fullSrc: hit.blobUrl }
  const status = peekCachedStatus(mediaId)
  return { status, fullSrc: null }
}

/**
 * Renders a media attachment by resolving its `mediaId` to a blob URL.
 *
 * Uses `readMediaBytes` (Tauri IPC) instead of `convertFileSrc` (asset protocol)
 * to avoid asset protocol scope restrictions. Blob URLs are kept alive in a
 * module-level LRU cache (`./mediaCache`) so switching between entries doesn't
 * force a re-fetch of bytes the user already viewed.
 *
 * States:
 * - **Loading** — fetching the status row; shows an animated skeleton.
 * - **Cached locally** — renders `<img>` / `<video>` / `<audio>` with a blob URL.
 * - **Cloud-only** — shows a "Tap to download" placeholder; click downloads.
 * - **Error** — shows an error placeholder with `role="alert"`.
 */
export function MediaAttachment({
  mediaId,
  alt = '',
  className,
  previewOnly = false,
  lazy = false,
  useThumbnail = false,
  skeletonClassName,
  skeletonIcon = false,
  placeholderVariant = 'inline',
  videoAutoPlay = false,
}: MediaAttachmentProps) {
  const { t } = useTranslation('editor')
  const initial = useRef<InitialState | null>(null)
  // Compute once per (mediaId, useThumbnail) combination. `useRef` (not
  // `useMemo`) is the right primitive here because we never want to
  // re-run the lookup for the same component instance — a re-render due
  // to state change inside the component must not overwrite our state.
  if (!initial.current || initial.current.status?.mediaId !== mediaId) {
    initial.current = initialFromCache(mediaId, useThumbnail)
  }

  const [status, setStatus] = useState<MediaStatus | null>(initial.current.status)
  const [fullSrc, setFullSrc] = useState<string | null>(initial.current.fullSrc)
  const [error, setError] = useState<Error | null>(null)
  const [downloading, setDownloading] = useState(false)

  useEffect(() => {
    let cancelled = false

    // If the cache already has the blob, we're done — initial state set
    // `fullSrc` synchronously above, and there's nothing async to do.
    if (peekCachedMedia(mediaId, useThumbnail)) return

    // Reset state for a fresh resolve when the mediaId changes between
    // renders (e.g. the gallery row recycles a cell with a new id).
    setError(null)

    const apply = (entry: CachedMedia | null) => {
      if (cancelled) return
      if (entry) {
        setStatus(entry.status)
        setFullSrc(entry.blobUrl)
      } else {
        // Cloud-only or unavailable — fetch the status so the cloud
        // badge / unavailable placeholder can render, AND kick off a
        // background download so the user almost never sees the
        // "Tap to download" affordance (per the auto-download UX policy).
        getMediaStatus(mediaId)
          .then((s) => {
            if (!cancelled) setStatus(s)
            // Auto-trigger backend download for cloud-only rows. The
            // useThumbnail flag matches what this attachment renders,
            // so the gallery and attachment-strip ask for the thumb
            // file and the inline editor asks for the full file.
            if (s.hasCloudCopy && !s.cachedLocally) {
              void ensureMediaCached(mediaId, useThumbnail)
            }
          })
          .catch((err) => {
            if (!cancelled) setError(err instanceof Error ? err : new Error(String(err)))
          })
      }
    }

    resolveCachedMedia(mediaId, useThumbnail)
      .then(apply)
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err : new Error(String(err)))
      })

    // Re-resolve when ensureMediaCached emits `media-cached` (a peer
    // cell's auto-DL or this cell's own auto-DL just finished writing
    // bytes to disk). Without this, a card that missed on first mount
    // stayed blank until full unmount/remount. Distinct from
    // `media-changed`, which is reserved for DB-row mutations
    // (insert/delete) and triggers TanStack invalidations.
    const onMediaCached = () => {
      if (cancelled) return
      const hit = peekCachedMedia(mediaId, useThumbnail)
      if (hit) {
        setStatus(hit.status)
        setFullSrc(hit.blobUrl)
        setError(null)
        return
      }
      // Cache still cold — re-attempt the resolve. resolveCachedMedia
      // dedupes via its `pending` map so this is safe to call from
      // multiple components for the same mediaId at once.
      resolveCachedMedia(mediaId, useThumbnail)
        .then(apply)
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err : new Error(String(err)))
        })
    }
    window.addEventListener('memlore:media-cached', onMediaCached)

    return () => {
      cancelled = true
      window.removeEventListener('memlore:media-cached', onMediaCached)
    }
    // We deliberately do NOT revoke blob URLs on unmount — they live in
    // the module cache and outlive the component, which is the whole
    // point of fixing the "switching entries re-loads images" bug. The
    // cache LRU and `invalidateMediaCache` (called from `deleteMedia`)
    // handle revocation.
  }, [mediaId, useThumbnail])

  const downloadFullImage = useCallback(async () => {
    if (downloading) return
    setDownloading(true)
    try {
      await resolveMedia(mediaId)
      // Manual success proves the row is reachable — drop any stale
      // negative-cache record for either thumb/full so other components
      // (or this same component for the thumb side) can retry without
      // waiting for the 30 s TTL.
      clearEnsureFailureFor(mediaId)
      // Force a fresh fetch through the cache — the row is now local.
      const entry = await resolveCachedMedia(mediaId, false)
      if (entry) {
        setStatus(entry.status)
        setFullSrc(entry.blobUrl)
      }
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      setDownloading(false)
    }
  }, [mediaId, downloading])

  if (error) {
    return (
      <div
        role="alert"
        aria-label={t('media_attachment.load_failed')}
        className={cn(
          'flex h-40 w-full items-center justify-center rounded-xl',
          'border-border-default bg-border-default border opacity-50',
          'text-fg text-sm',
          className,
        )}
      >
        {t('media_attachment.unavailable')}
      </div>
    )
  }

  // When the backend recorded the image's intrinsic dimensions at insert
  // time, surface them as `aspect-ratio` on the loading skeleton + HTML
  // `width`/`height` attrs on the <img>. The browser uses those attrs to
  // reserve an aspect-ratio-correct box BEFORE the src finishes decoding
  // — eliminating the original "blank gap then sudden pop-in". Falls back
  // to a fixed-height skeleton for legacy rows where dimensions are null.
  const hasDims = !!(status && status.width && status.height)
  const skeletonStyle: CSSProperties | undefined = hasDims
    ? { aspectRatio: `${status!.width} / ${status!.height}` }
    : undefined

  // Skeleton — uses `bg-panel-2` (solid, theme-aware token) instead of
  // `bg-border-default` (rgba w/ 0.15 alpha). The previous token was so
  // translucent that against a white editor background the placeholder
  // was nearly invisible, which is why the user reported "still blank
  // space, not even a skeleton". `animate-pulse` cycles the opacity to
  // signal that loading is in progress.
  //
  // Width handling is subtle: the TipTap NodeViewWrapper renders as
  // `<span class="inline-block">`, which shrink-wraps its child. A bare
  // `w-full` on the skeleton therefore collapses to 0px wide and the
  // user sees nothing. We use a width that's large enough to fill the
  // editor's content column (max 640px - 48px padding = 592px) — the
  // inline-block parent then expands to the child's width, capped by
  // its own containing block, which IS the editor column. Effective
  // result: skeleton always fills the editor width. When dims ARE
  // known, `aspect-ratio` keeps the height in lockstep so the skeleton
  // matches the eventual image box exactly. `max-w-full` is the
  // safety net for callers that constrain MediaAttachment to a
  // smaller container (e.g. attachment strip's 64×64 thumbnails) —
  // their className passes `h-full w-full` which wins via tailwind-
  // merge and overrides our defaults below.
  // Skeleton fill — light mode uses a darker neutral than `bg-panel-2`
  // (which is near-white at oklch 98.5%) so the placeholder is clearly
  // visible against the white editor canvas. Dark mode keeps the panel
  // token, which already has enough contrast against the dark canvas.
  const skeletonClass = cn(
    'block animate-pulse rounded-xl bg-black/8 dark:bg-panel-2',
    hasDims ? 'w-148 max-w-full' : 'h-40 w-148 max-w-full',
    className,
    skeletonClassName,
  )

  // Compact (64×64 attachment-strip cell) needs a smaller icon than the
  // inline editor variant — `size-8` would crowd the cell. `size-5`
  // (20px) leaves a comfortable margin inside the 64px box.
  const skeletonIconSize = placeholderVariant === 'compact' ? 'size-6' : 'size-8'

  if (!status) {
    return (
      <div role="status" aria-label={t('media_attachment.loading')} className={skeletonClass}>
        {skeletonIcon && (
          <span className="flex h-full w-full items-center justify-center">
            <ImageIcon className={cn('text-fg-muted/40', skeletonIconSize)} aria-hidden="true" />
          </span>
        )}
      </div>
    )
  }

  const isVideo = status.fileType.startsWith('video/')
  const isAudio = status.fileType.startsWith('audio/')

  // DESIGN-TIME: when the flag is on, skip the resolved <img>/<video> branch
  // for non-audio media so the skeleton renders in its place, sized to the
  // real intrinsic dimensions when known. Audio is untouched (no skeleton
  // shape to design).
  if (
    fullSrc &&
    !(FORCE_SKELETON_FOR_DESIGN && !isAudio) &&
    !(FORCE_TAP_TO_DOWNLOAD_FOR_DESIGN && !isAudio)
  ) {
    if (isAudio) {
      return <AudioPlayer src={fullSrc} alt={alt || undefined} className={className} />
    }
    if (isVideo) {
      // Video: <video> mounts at full opacity with a `bg-panel-2` fill,
      // and the first frame paints on top once `preload="metadata"` is
      // ready. `style={skeletonStyle}` reserves the aspect-correct box
      // up front (only when dims are known). No opacity transition: it
      // would zero the bg-color too and re-introduce the blank-gap bug
      // we are fixing — instead the placeholder is visible during
      // decode and is simply covered when frame 0 paints.
      // The `bg-panel-2` fill is the in-place skeleton color the browser
      // shows while `<video>` is fetching metadata + frame 0. It already
      // matches the gallery cell wrapper; hosts on a different surface
      // override it via `skeletonClassName` so the pre-paint frame matches
      // instead of flashing a differently-tinted gray.
      const sharedVideoClass = cn(
        'block max-w-full rounded-xl bg-black/8 dark:bg-panel-2',
        className,
        skeletonClassName,
      )
      // Small overlay chip confirming the file was background-compressed, with
      // its current (compressed) on-disk size. Only shown for the inline player.
      const compressedBadge =
        status.compressed && status.fileSize != null ? (
          <span
            className="text-2xs pointer-events-none absolute top-2 left-2 z-10 rounded-md bg-black/60 px-1.5 py-0.5 font-medium text-white backdrop-blur-sm"
            title={t('media_attachment.compressed_tooltip')}
          >
            {t('media_attachment.compressed_badge', { size: formatBytes(status.fileSize) })}
          </span>
        ) : null
      if (previewOnly) {
        // Two cases when previewOnly is set for a video tile:
        //   1. `useThumbnail` AND the row has a `thumbnail_path` → `fullSrc`
        //      points to the JPEG poster blob (MIME pinned `image/jpeg` in
        //      mediaCache.ts). Render `<img>` so the JPEG actually decodes.
        //   2. No thumbnail available → `fullSrc` points to the full video
        //      bytes blob (MIME `video/mp4`). Render `<video>` and let the
        //      browser fetch frame 0 via `preload="metadata"`.
        const hasJpegPoster = useThumbnail && !!status.thumbnailPath
        if (hasJpegPoster) {
          return (
            <img
              src={fullSrc}
              alt={alt || 'Video preview'}
              style={skeletonStyle}
              className={cn('pointer-events-none object-cover', sharedVideoClass)}
            />
          )
        }
        return (
          <video
            src={fullSrc}
            muted
            playsInline
            preload="metadata"
            aria-label={alt || 'Video preview'}
            style={skeletonStyle}
            className={cn('pointer-events-none', sharedVideoClass)}
          />
        )
      }
      return (
        <div className="relative inline-block max-w-full">
          <video
            src={fullSrc}
            controls
            autoPlay={videoAutoPlay}
            preload="metadata"
            aria-label={alt || undefined}
            style={skeletonStyle}
            className={sharedVideoClass}
          />
          {compressedBadge}
        </div>
      )
    }
    // Image: HTML `width`/`height` attrs let the browser compute the
    // aspect ratio and reserve the layout box BEFORE the bytes decode.
    // A `bg-panel-2` fill acts as the in-place skeleton during that
    // decode — when the pixels are ready, they paint on top and
    // visually replace it.
    //
    // We deliberately do NOT use an opacity-0 → opacity-100 fade here:
    // `opacity: 0` zeroes the entire <img> including its background, so
    // the skeleton color would be invisible during decode and the
    // original "blank gap then pop-in" bug would return.
    //
    // `max-w-full h-auto` keeps the previous "render at intrinsic size,
    // scale down to parent width" behaviour in the editor; the gallery
    // passes `h-full w-full object-cover` via `className` to override
    // that for fixed grid cells.
    // `bg-panel-2` is the in-place skeleton color the browser shows while
    // the blob URL fetches + decodes — once the pixels paint, they cover
    // it. It already matches the gallery cell wrapper; hosts on a different
    // surface override via `skeletonClassName` so the pre-paint frame
    // matches instead of flashing a differently-tinted gray.
    return (
      <img
        src={fullSrc}
        alt={alt}
        width={status.width ?? undefined}
        height={status.height ?? undefined}
        className={cn(
          'dark:bg-panel-2 block max-w-full rounded-xl bg-black/8',
          hasDims ? 'h-auto' : '',
          className,
          skeletonClassName,
        )}
        loading={lazy ? 'lazy' : 'eager'}
        decoding="async"
      />
    )
  }

  // Status loaded but no fullSrc yet — bytes still in flight. Use the
  // same aspect-correct skeleton so there's no jump when the <img>
  // finally mounts.
  if (status.cachedLocally && !(FORCE_TAP_TO_DOWNLOAD_FOR_DESIGN && !isAudio)) {
    const showIcon = skeletonIcon && !isVideo && !isAudio
    return (
      <div
        role="status"
        aria-label={t('media_attachment.loading')}
        style={skeletonStyle}
        className={skeletonClass}
      >
        {showIcon && (
          <span className="flex h-full w-full items-center justify-center">
            <ImageIcon className={cn('text-fg-muted/40', skeletonIconSize)} aria-hidden="true" />
          </span>
        )}
      </div>
    )
  }

  if (status.hasCloudCopy || (FORCE_TAP_TO_DOWNLOAD_FOR_DESIGN && !isAudio)) {
    const kindLabel = isVideo ? 'video' : isAudio ? 'audio' : 'image'
    const ariaLabel = downloading ? `Downloading ${kindLabel}…` : `Tap to download ${kindLabel}`

    // Icon block: a Cloud (or Music for audio) with an animated down-arrow
    // overlaid when a download is in flight. The arrow slides from above
    // the cloud into the bottom of the box on a 1.1s loop. When idle
    // (waiting on user tap), we show the icon static + a small "tap to ↓"
    // label below. The two layouts share the icon size + position so the
    // transition from idle → downloading is a pure overlay swap, no
    // layout shift.
    const isCompact = placeholderVariant === 'compact'
    const iconSize = isCompact ? 'size-5' : 'size-8'
    const arrowSize = isCompact ? 'size-3' : 'size-4'
    const BaseIcon = isAudio ? Music : Cloud
    const iconBlock = (
      <span
        className={cn(
          'relative flex items-center justify-center',
          isCompact ? 'size-6' : 'size-10',
        )}
      >
        <BaseIcon className={cn('text-fg-muted', iconSize)} aria-hidden="true" />
        {downloading && (
          <ArrowDown
            aria-hidden="true"
            className={cn('media-download-arrow text-accent-text absolute', arrowSize)}
          />
        )}
      </span>
    )

    if (isCompact) {
      // 64×64 cell in the attachment strip below the editor.
      // Compact layout: icon on line 1, "tap to ↓" micro-label on line 2.
      // While downloading, hide the label so the arrow animation is the
      // sole affordance (per the auto-download UX policy: no text noise).
      return (
        <button
          type="button"
          onClick={downloadFullImage}
          aria-label={ariaLabel}
          className={cn(
            'media-tap-placeholder flex flex-col items-center justify-center gap-0.5 rounded-xl',
            'border-border-default bg-border-default border opacity-60',
            'text-fg cursor-pointer',
            'hover:opacity-80',
            className,
          )}
          data-testid="cloud-badge"
        >
          {iconBlock}
          {!downloading && (
            <span className="text-2xs leading-none">{t('media_attachment.tap_to_download')}</span>
          )}
        </button>
      )
    }

    if (placeholderVariant === 'fill') {
      // Gallery / lightbox cell — fills the parent box exactly. The caller
      // controls aspect-ratio via the wrapper; we just match `className`
      // and center the icon block inside.
      //
      // `min-h-50 min-w-50` guards the lightbox case: the
      // lightbox parent only constrains `max-*` (max-h:90vh / max-w:90vw)
      // with no defined width/height. Without min-dimensions the
      // placeholder would collapse to its content (~80 px icon block),
      // floating disorientingly in the middle of the black overlay. The
      // gallery's `aspect-square` parent already has defined dimensions,
      // so `min-*` there is a no-op (the cell width drives the box). For
      // rows where backend reported intrinsic dimensions, `skeletonStyle`
      // adds `aspect-ratio` on top so the box matches the eventual image.
      return (
        <button
          type="button"
          onClick={downloadFullImage}
          aria-label={ariaLabel}
          style={skeletonStyle}
          className={cn(
            'media-tap-placeholder flex h-full min-h-50 w-full min-w-50 flex-col items-center justify-center gap-1 rounded-xl',
            'border-border-default bg-border-default border opacity-60',
            'text-fg cursor-pointer',
            'hover:opacity-80',
            className,
          )}
          data-testid="cloud-badge"
        >
          {iconBlock}
          {!downloading && (
            <span className="text-fg-muted text-xs leading-none">
              {t('media_attachment.tap_to_download')}
            </span>
          )}
        </button>
      )
    }

    // Inline / large variant — fills the media node's box (`w-full`). On a
    // separated line the node is already the editor column (or a centered
    // % width); floated left/right nodes keep their float width, so this
    // does not stretch a float across the column. `.media-tap-placeholder`
    // opts out of the Clean corner-radius sweep so `rounded-xl` stays
    // small-rounded at medium/high instead of inheriting --button-radius.
    return (
      <button
        type="button"
        onClick={downloadFullImage}
        aria-label={ariaLabel}
        style={skeletonStyle}
        className={cn(
          'media-tap-placeholder flex w-full flex-col items-center justify-center gap-2 rounded-xl',
          'border-border-default bg-border-default border opacity-60',
          'text-fg cursor-pointer',
          'hover:opacity-80',
          hasDims ? '' : 'h-32',
          className,
        )}
        data-testid="cloud-badge"
      >
        {iconBlock}
        {!downloading && (
          <span className="text-fg-muted text-xs leading-none">
            {t('media_attachment.tap_to_download')}
          </span>
        )}
      </button>
    )
  }

  const unavailableLabel = isVideo
    ? 'Video unavailable'
    : isAudio
      ? 'Audio unavailable'
      : 'Image unavailable'
  return (
    <div
      role="alert"
      aria-label={unavailableLabel}
      className={cn(
        'flex h-40 w-full items-center justify-center rounded-xl',
        'bg-panel-2 border-border-default border opacity-50',
        'text-fg text-sm',
        className,
      )}
    >
      {unavailableLabel}
    </div>
  )
}
