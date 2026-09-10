import { useMemo } from 'react'
import {
  Download,
  Eye,
  File as FileIcon,
  Mic,
  Play,
  X,
  ZoomIn,
  ChevronUp,
  ChevronDown,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { getAttachmentKind } from '../../lib/attachmentKind'
import {
  buildAttachmentSummaryParts,
  countAttachmentTypes,
  type AttachmentSummaryPartKey,
} from '../../lib/attachmentStripSummary'
import type { MediaRow } from '../../lib/tauri'
import { Button } from '../common/Button'
import { Tooltip } from '../common/Tooltip'
import { MediaAttachment } from '../media/MediaAttachment'

interface AttachmentStripProps {
  attachments: MediaRow[]
  onRemoveRequest: (mediaId: string) => void
  /**
   * Fired when the user clicks an image (zoom icon hover) OR a video (play
   * icon hover) attachment tile. Parent opens the shared MediaLightbox so
   * images and videos share one carousel — videos play there, not inline
   * in the strip.
   */
  onZoomRequest?: (mediaId: string) => void
  /**
   * Fired when the user clicks an audio thumbnail. The parent should open a
   * listen-only modal with the audio player and speed controls. If omitted,
   * audio tiles render but become non-interactive (still show the remove btn).
   */
  onPlayAudioRequest?: (mediaId: string) => void
  /**
   * Fired when the user clicks the eye icon on a previewable non-media file
   * (PDF, text, code). Parent opens the FileViewerModal.
   */
  onViewFileRequest?: (mediaId: string) => void
  /**
   * Fired when the user clicks the download icon on an unsupported-preview
   * attachment. Parent invokes the Save As… dialog flow.
   */
  onDownloadFileRequest?: (mediaId: string) => void
  /** When true, only the summary line is shown instead of thumbnails. */
  collapsed?: boolean
  /** Toggle collapse/expand. Parent owns persisted preference. */
  onCollapsedChange?: (collapsed: boolean) => void
}

/**
 * Horizontal scrollable strip of media thumbnails (images, video, audio).
 * Audio tiles render a mic icon + "Voice memo" label rather than a full
 * `<audio>` element, since the 64×64 tile cannot fit native controls; clicking
 * the tile opens a dedicated playback modal via `onPlayAudioRequest`.
 */
export function AttachmentStrip({
  attachments,
  onRemoveRequest,
  onZoomRequest,
  onPlayAudioRequest,
  onViewFileRequest,
  onDownloadFileRequest,
  collapsed = true,
  onCollapsedChange,
}: AttachmentStripProps) {
  const { t } = useTranslation('editor')

  const typeCounts = useMemo(() => countAttachmentTypes(attachments), [attachments])
  const summaryText = useMemo(() => {
    const parts = buildAttachmentSummaryParts(typeCounts)
    return parts
      .map((key: AttachmentSummaryPartKey) =>
        t(`attachment_strip.summary_${key}`, { count: typeCounts[key] }),
      )
      .join(', ')
  }, [t, typeCounts])

  if (attachments.length === 0) return null

  function formatDuration(seconds: number | null): string {
    if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return ''
    const total = Math.round(seconds)
    const mm = Math.floor(total / 60)
    const ss = total % 60
    return `${mm}:${ss.toString().padStart(2, '0')}`
  }

  const canToggle = Boolean(onCollapsedChange)

  const handleToggle = () => {
    if (!onCollapsedChange) return
    onCollapsedChange(!collapsed)
  }

  const handleExpand = () => {
    if (!onCollapsedChange || !collapsed) return
    onCollapsedChange(false)
  }

  const toggleTooltip = collapsed
    ? t('attachment_strip.expand_tooltip')
    : t('attachment_strip.collapse_tooltip')

  const toggleAria = collapsed
    ? t('attachment_strip.expand_aria')
    : t('attachment_strip.collapse_aria')

  return (
    <div className="border-border-default from-panel-3 group relative shrink-0 border-t bg-linear-to-r to-white/3">
      {collapsed ? (
        <button
          type="button"
          onClick={handleExpand}
          aria-label={toggleAria}
          aria-expanded={false}
          className="hover:bg-surface-row-hover flex h-8 w-full cursor-pointer items-center gap-2 border-none bg-transparent px-4 text-left transition-colors motion-reduce:transition-none"
        >
          <span className="text-fg-secondary min-w-0 flex-1 truncate text-xs">{summaryText}</span>
          <ChevronUp
            className="text-fg-muted size-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 motion-reduce:transition-none"
            aria-hidden
          />
        </button>
      ) : (
        <div className="flex flex-row gap-2 overflow-x-auto px-4 py-2 pr-10">
          {attachments.map((item) => {
            const isImage = item.file_type.startsWith('image/')
            const isAudio = item.file_type.startsWith('audio/')
            const isVideo = item.file_type.startsWith('video/')
            const isFile = !isImage && !isAudio && !isVideo

            return (
              // Tile button (view/download/play/zoom) and the X remove button are
              // siblings — clicks on X do not bubble to the tile button.
              <div
                key={item.id}
                className="group/tile relative h-16 w-16 shrink-0 overflow-hidden rounded-lg"
              >
                {isAudio ? (
                  <button
                    type="button"
                    onClick={() => onPlayAudioRequest?.(item.id)}
                    disabled={!onPlayAudioRequest}
                    aria-label={t('attachment_strip.play_voice_memo_aria')}
                    className="bg-accent-soft text-accent-text hover:bg-accent-soft/80 flex h-full w-full cursor-pointer flex-col items-center justify-center gap-0.5 border-none p-1 transition-colors disabled:cursor-default motion-reduce:transition-none"
                  >
                    <Mic className="size-5" />
                    <span className="font-mono text-xs leading-tight font-medium tabular-nums">
                      {formatDuration(item.duration_seconds) || '--:--'}
                    </span>
                  </button>
                ) : isFile ? (
                  (() => {
                    const kind = getAttachmentKind(item.file_name, item.file_type)
                    const canView = kind === 'pdf' || kind === 'text'
                    const action = canView
                      ? () => onViewFileRequest?.(item.id)
                      : () => onDownloadFileRequest?.(item.id)
                    const handler = canView ? onViewFileRequest : onDownloadFileRequest
                    const ariaLabel = canView
                      ? t('attachment_strip.view_aria')
                      : t('attachment_strip.download_aria')
                    const HoverIcon = canView ? Eye : Download

                    return (
                      <button
                        type="button"
                        title={item.file_name}
                        aria-label={ariaLabel}
                        onClick={action}
                        disabled={!handler}
                        className="bg-panel-2 text-fg-secondary border-border-default hover:bg-surface-row-hover flex h-full w-full cursor-pointer flex-col items-center justify-center gap-0.5 rounded-lg border p-1 transition-colors disabled:cursor-default motion-reduce:transition-none"
                      >
                        <FileIcon className="size-5 shrink-0" aria-hidden />
                        <span className="text-2xs block w-full truncate text-center leading-tight font-medium">
                          {item.file_name}
                        </span>
                        {/* Centered hover icon — mirrors the ZoomIn pattern used by
                            the image branch. `pointer-events-none` on the overlay
                            so the underlying button still receives the click. */}
                        {handler && (
                          <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/35 opacity-0 transition-opacity group-hover/tile:opacity-100 motion-reduce:transition-none">
                            <HoverIcon
                              className="size-4 text-white drop-shadow-md"
                              aria-hidden="true"
                            />
                          </span>
                        )}
                      </button>
                    )
                  })()
                ) : (
                  // Image + video tiles share the same structure: a non-interactive
                  // <MediaAttachment> thumbnail underneath, with hover-revealed
                  // action icons (ZoomIn for image, Play for video) on top. Video
                  // uses `previewOnly` so the strip never renders native
                  // `<video controls>` — playback happens in the MediaLightbox
                  // carousel triggered by the hover icon.
                  <MediaAttachment
                    mediaId={item.id}
                    className="h-full w-full object-cover"
                    useThumbnail
                    previewOnly={isVideo}
                    placeholderVariant="compact"
                    skeletonIcon
                  />
                )}

                {/* Remove button — top-right corner */}
                <div className="absolute top-0 right-0 p-0.5 opacity-0 transition-opacity group-hover/tile:opacity-100 motion-reduce:transition-none">
                  <button
                    type="button"
                    className="cursor-pointer rounded-full border-none bg-black/60 p-0.5 text-white"
                    onClick={() => onRemoveRequest(item.id)}
                    aria-label={t('attachment_strip.remove_aria')}
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
                {/* Video tiles: persistent Play badge centered on the thumbnail
                    so the tile reads as "this is a video" even before hover. A
                    circular black scrim sits under the white glyph so it stays
                    readable on bright poster frames. The badge brightens on
                    hover and acts as the click target that opens the shared
                    MediaLightbox. */}
                {isVideo && onZoomRequest && (
                  <button
                    type="button"
                    className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-full border-none bg-black/45 p-1.5 text-white opacity-80 drop-shadow-md transition-opacity group-hover/tile:opacity-100 hover:bg-black/65 hover:opacity-100 motion-reduce:transition-none"
                    onClick={() => onZoomRequest(item.id)}
                    aria-label={t('attachment_strip.play_aria')}
                  >
                    <Play className="size-3.5 fill-white" />
                  </button>
                )}
                {/* Image tiles keep the hover-only ZoomIn — they don't need a
                    persistent "this is media" affordance since the photo
                    already reads at a glance. */}
                {isImage && onZoomRequest && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover/tile:opacity-100 motion-reduce:transition-none">
                    <button
                      type="button"
                      className="pointer-events-auto cursor-pointer border-none bg-transparent p-0 text-white drop-shadow-md"
                      onClick={() => onZoomRequest(item.id)}
                      aria-label={t('attachment_strip.zoom_aria')}
                    >
                      <ZoomIn className="size-4" />
                    </button>
                  </div>
                )}
                {/* Inline badge — bottom-right corner. Skipped for audio since
                    audio is attachment-only as of voice-memos v2. */}
                {!isAudio && item.insertion_mode === 'inline' && (
                  <div
                    className="text-2xs pointer-events-none absolute right-1 bottom-1 rounded-full bg-black/75 px-1.5 py-0.5 leading-none font-medium text-white"
                    aria-label={t('attachment_strip.inline_badge_aria')}
                  >
                    {t('attachment_strip.inline_badge')}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {canToggle && !collapsed && (
        <div className="absolute top-1/2 right-2 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100 motion-reduce:transition-none">
          <Tooltip content={toggleTooltip} placement="top">
            <Button
              variant="ghost"
              size="sm"
              aria-label={toggleAria}
              aria-expanded
              onClick={handleToggle}
              className="rounded-lg"
              style={{ padding: '0 6px' }}
              icon={<ChevronDown className="size-4" aria-hidden />}
            />
          </Tooltip>
        </div>
      )}
    </div>
  )
}
