import { useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { NodeViewWrapper } from '@tiptap/react'
import type { ReactNodeViewProps } from '@tiptap/react'
import { X, ZoomIn } from 'lucide-react'
import { MediaAttachment } from '../media/MediaAttachment'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { invalidateMediaCache } from '../media/mediaCache'
import { useMediaZoom } from './MediaZoomContext'
import { cn } from '../../lib/cn'

/**
 * TipTap ReactNodeView for the ImageWithMediaId extension.
 *
 * When a node carries a `data-media-id` attribute, this component renders
 * `MediaAttachment` which lazily resolves the media to a blob URL
 * (downloading from cloud if the file is missing). When the
 * attribute is absent (legacy entries that store a raw `src`), falls back
 * to a plain `<img>`.
 *
 * Wrapped in TipTap's `NodeViewWrapper` so ProseMirror can mount/unmount
 * the React tree alongside the editor lifecycle.
 *
 * Images are repositioned via the ↑/↓ buttons in `ImageBubbleMenu` (drag
 * was ruled out: macOS WKWebView never fires HTML5 `dragstart` inside a
 * `contenteditable` root, and pointer-drag lost to simpler toolbar buttons).
 *
 * When the editor is editable, hovering any media node reveals a remove
 * button. Clicking it opens a confirmation dialog. On confirm, the node is
 * removed from the document; the backing row is deleted after the entry
 * save confirms (see `inlineMediaDeletionTracker`).
 */
export function MediaNodeView({
  node,
  editor,
  getPos,
}: Pick<ReactNodeViewProps, 'node' | 'editor' | 'getPos'>) {
  const { t } = useTranslation('editor')
  const mediaId = node.attrs['data-media-id'] as string | null | undefined
  const mediaMissing = Boolean(node.attrs['data-media-missing'])
  const src = node.attrs.src as string | undefined
  const alt = (node.attrs.alt as string | undefined) ?? ''

  const [hovered, setHovered] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const zoomCtx = useMediaZoom()

  const handleConfirmRemove = () => {
    if (mediaId) {
      // Drop any stale blob URL for this media id from the module cache
      // so a future image with the same UUID (theoretically impossible
      // but cheap to guard) doesn't resolve to a revoked URL.
      invalidateMediaCache(mediaId)
      zoomCtx?.onMediaRemoved()
    }
    // Remove the node only. The inline-media tracker observes the disappearance,
    // marks the id pending, and deletes the row after this entry's next durable
    // save (fired immediately below).
    const pos = typeof getPos === 'function' ? getPos() : undefined
    if (pos !== undefined && editor) {
      editor
        .chain()
        .focus()
        .deleteRange({ from: pos, to: pos + node.nodeSize })
        .run()
    }
    // Flush save immediately so the node removal is persisted; the tracker
    // drains the pending byte-delete on that saved event.
    zoomCtx?.onImmediateSave?.()
  }

  const showRemoveButton = hovered && editor?.isEditable && Boolean(mediaId || mediaMissing)
  // Show zoom on hover whenever a mediaId is present (both editable and read-only).
  const showZoomButton = hovered && Boolean(mediaId) && !mediaMissing

  const isImage = node.type.name === 'image'
  const isVideo = node.type.name === 'video'
  const isEditableImage = isImage && editor?.isEditable

  // Inline video controls (align / size / move) live in the floating
  // `VideoBubbleMenu`, shown above the clip while the node is selected — the
  // same toolbar language as images. Only the layout-driving attrs are read
  // here so `wrapperStyle` can position the wrapper; the setters live in the
  // bubble menu.
  const align = isImage
    ? (node.attrs['data-align'] as 'left' | 'right' | 'full' | undefined)
    : undefined
  const width = isImage ? (node.attrs['data-width'] as number | null) : null

  // Videos carry a `data-width` percentage preset (30/50/70/100). Null means
  // "intrinsic size, centered". Setting it makes the wrapper a fixed-percentage
  // block (or float box) so the <video> (rendered `w-full` when sized) fills it.
  const videoWidth = isVideo ? (node.attrs['data-width'] as number | null) : null
  // Float alignment: null = centered (default for a fresh clip), 'left'/'right'
  // = floated. Mirrors the image alignment model.
  const videoAlign = isVideo ? (node.attrs['data-align'] as 'left' | 'right' | null) : null
  const videoFloated = videoAlign === 'left' || videoAlign === 'right'

  const effectiveWidth = width ?? 100
  const floated = isImage && align && align !== 'full'
  const narrowedBlock = isImage && !floated && effectiveWidth < 100

  const wrapperStyle: CSSProperties | undefined = floated
    ? align === 'left'
      ? {
          float: 'left',
          width: `${effectiveWidth}%`,
          marginRight: '1rem',
          marginBottom: '0.5rem',
        }
      : {
          float: 'right',
          width: `${effectiveWidth}%`,
          marginLeft: '1rem',
          marginBottom: '0.5rem',
        }
    : narrowedBlock
      ? {
          display: 'block',
          width: `${effectiveWidth}%`,
          maxWidth: '100%',
          marginLeft: 'auto',
          marginRight: 'auto',
          marginBottom: '0.5rem',
        }
      : videoFloated
        ? {
            float: videoAlign as 'left' | 'right',
            width: `${videoWidth ?? 50}%`,
            ...(videoAlign === 'left' ? { marginRight: '1rem' } : { marginLeft: '1rem' }),
            marginBottom: '0.5rem',
          }
        : // Centered inline video (the default). With a `data-width` preset the
          // wrapper is a fixed-percentage block; without one it shrink-wraps to
          // the clip's intrinsic size via `fit-content`. Either way `margin:
          // auto` centers it and keeps the absolute hover buttons hugging the
          // video's corners instead of the full-width column edge.
          isVideo
          ? {
              display: 'block',
              width: videoWidth != null ? `${videoWidth}%` : 'fit-content',
              maxWidth: '100%',
              marginLeft: 'auto',
              marginRight: 'auto',
            }
          : undefined

  const isFullWidthBlock = isImage
    ? !floated && effectiveWidth === 100
    : isVideo
      ? !videoFloated && videoWidth === 100
      : node.type.name === 'audio'

  const wrapperClassName = cn(
    floated || narrowedBlock || isVideo ? 'relative block' : 'relative inline-block w-full',
    isFullWidthBlock && 'media-node--full-width',
  )

  if (mediaMissing) {
    return (
      <NodeViewWrapper
        as="span"
        className={cn('relative inline-block w-full', 'media-node--full-width')}
      >
        <span
          className="relative block w-full"
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          <div
            role="status"
            aria-label={t('media_attachment.not_found')}
            className="border-border-default bg-panel-2 text-fg-muted flex h-40 w-full items-center justify-center rounded-xl border text-sm"
          >
            {t('media_attachment.not_found')}
          </div>
          {showRemoveButton && (
            <button
              type="button"
              className="absolute top-1.5 right-1.5 z-10 cursor-pointer rounded-full border-none bg-black/60 p-1 text-white"
              aria-label={t('media.remove_aria')}
              onClick={() => setConfirmOpen(true)}
            >
              <X className="size-4" />
            </button>
          )}
        </span>
        {confirmOpen && (
          <ConfirmDialog
            open={true}
            title={t('confirm_remove_media.title')}
            description={t('confirm_remove_media.description')}
            confirmLabel={t('confirm_remove_media.confirm')}
            onConfirm={handleConfirmRemove}
            onClose={() => setConfirmOpen(false)}
          />
        )}
      </NodeViewWrapper>
    )
  }

  if (mediaId) {
    return (
      <NodeViewWrapper
        as="span"
        // The `.media-node` class that suppresses the generic 2px selection
        // outline lives on the outer `.react-renderer` element (set via
        // ReactNodeViewRenderer's `className` in Editor.tsx) — that's the
        // element ProseMirror tags with `.ProseMirror-selectednode`.
        className={wrapperClassName}
        style={wrapperStyle}
        // Keeps WebKit from putting a caret inside the node view (matches
        // TipTap's official image node-view pattern).
        contentEditable={isEditableImage ? false : undefined}
      >
        <span
          className={wrapperClassName}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          <MediaAttachment
            mediaId={mediaId}
            alt={alt}
            skeletonIcon
            className={isImage || videoFloated || videoWidth != null ? 'w-full' : undefined}
          />
          {showRemoveButton && (
            <button
              type="button"
              className="absolute top-1.5 right-1.5 z-10 cursor-pointer rounded-full border-none bg-black/60 p-1 text-white"
              aria-label={t('media.remove_aria')}
              onClick={() => setConfirmOpen(true)}
            >
              <X className="size-4" />
            </button>
          )}
          {showZoomButton && (
            <button
              type="button"
              className="absolute top-1.5 z-10 cursor-pointer rounded-full border-none bg-black/60 p-1 text-white"
              style={{ right: showRemoveButton ? '2.25rem' : '0.375rem' }}
              aria-label={isVideo ? 'Zoom video' : 'Zoom image'}
              onClick={() => zoomCtx?.onZoom(mediaId)}
            >
              <ZoomIn className="size-4" />
            </button>
          )}
        </span>
        {confirmOpen && (
          <ConfirmDialog
            open={true}
            title={t('confirm_remove_media.title')}
            description={t('confirm_remove_media.description')}
            confirmLabel={t('confirm_remove_media.confirm')}
            onConfirm={handleConfirmRemove}
            onClose={() => setConfirmOpen(false)}
          />
        )}
      </NodeViewWrapper>
    )
  }

  // Legacy fallback: the image was inserted without media-id (e.g. copied from clipboard).
  // `.media-node` (the selection-outline suppressor) is set on the outer
  // `.react-renderer` element via the renderer's `className` in Editor.tsx.
  return (
    <NodeViewWrapper as="span">
      <img src={src} alt={alt} className="max-w-full rounded-xl" loading="lazy" />
    </NodeViewWrapper>
  )
}
