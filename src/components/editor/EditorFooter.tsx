import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  useFloating,
  useDismiss,
  useInteractions,
  offset,
  flip,
  shift,
  autoUpdate,
  FloatingPortal,
} from '@floating-ui/react'
import {
  Compass,
  LayoutTemplate,
  Image,
  Film,
  Mic,
  ListOrdered,
  ListChecks,
  Paperclip,
  Sparkles,
  WandSparkles,
  Palette,
  Table as TableIcon,
  Code2,
  ChevronRight,
  Minus,
  Plus,
  Sigma,
  FunctionSquare,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '../common/Button'
import { Modal } from '../common/Modal'
import { ShimmerText } from '../common/ShimmerText'
import { InlineOrb } from '../common/ThinkingOrb'
import { Tooltip } from '../common/Tooltip'
import { cn } from '../../lib/cn'
import { toast } from '../../lib/toast'
import { extractAiErrorCode } from '../../lib/aiErrorCode'

/// Toolbar buttons (AI / More) override the ghost variant's default
/// `rounded-full` so the footer reads as a flat row of icons. Hover
/// fill comes from the ghost variant (`hover:bg-surface-hi`).
const TOOLBAR_BUTTON_CLASS = 'rounded-lg'
const TOOLBAR_ICON_BUTTON_STYLE = { padding: '0 8px' } as const
import { VoiceMemoModal } from './AudioRecorderButton'
import { EntryTagsPill } from './EntryTagsPill'
import { EntryJournalBadge } from './EntryJournalBadge'
import { useImageInsertPicker } from '../../hooks/useImageInsertPicker'
import type { InsertImageActionId } from '../../hooks/useImageInsertPicker'
import { InsertImagePopover } from './InsertImagePopover'
import { useVideoInsertPicker } from '../../hooks/useVideoInsertPicker'
import type { InsertVideoActionId } from '../../hooks/useVideoInsertPicker'
import { InsertVideoPopover } from './InsertVideoPopover'
import { useFilePicker } from '../../hooks/useFilePicker'
import { useTemplates } from '../../hooks/useTemplates'
import { TemplatePicker } from '../templates/TemplatePicker'
import { Star } from '../common/primitives'
import type { Editor } from '@tiptap/react'
import type { Entry } from '../../types/entry'
import type { Template } from '../../types/template'
import type { Journal } from '../../types/journal'
import { GenerateImageDialog } from './GenerateImageButton'
import type { GenerateImageResult } from '../../lib/tauri'
import { useAiImageGenerationEnabled } from '../../hooks/useAiImageGenerationEnabled'
import { AiIcon } from '../common/AiIcon'

interface EditorFooterProps {
  entry: Entry
  journal?: Journal | null
  editor: Editor | null
  onToggleFavorite: () => void
  onApplyTemplate?: (template: Template) => void
  /** Called after a new attachment is picked so the parent can refetch the strip. */
  onAttachmentAdded?: () => void | Promise<void>
  /** Called after an inline image is inserted via the "Aa" menu so the
   *  parent can refetch the entry — a freshly-set `cover_media_id` needs
   *  to propagate into the entry-list card on the left panel. */
  onInlineImageInserted?: () => void | Promise<void>
  // ── AI affordance slots (Phase 6 v2) ──
  /** Whether the AI Highlights toggle is on. When false, the button is hidden. */
  highlightsEnabled?: boolean
  /** Whether the AI Go-Deeper toggle is on. When false, the button is hidden. */
  goDeeperEnabled?: boolean
  /** Live word count of the entry body. Drives the ≥80-word gate that
   *  surfaces a tooltip ("write N more words") instead of letting the
   *  user click into a feature that has no signal yet. */
  wordCount?: number
  /** Render function for the Highlights popover. EditorFooter owns the
   *  open/close state and click-outside dismiss; the parent renders the
   *  actual popover content (which subscribes to the long-lived
   *  `useEntryHighlights` hook on EditorPanel). The render-prop pattern
   *  keeps stream state outside the footer's lifecycle. */
  renderHighlightsPopover?: (close: () => void) => ReactNode
  /** Same shape as `renderHighlightsPopover` for the Go-Deeper popover. */
  renderGoDeeperPopover?: (close: () => void) => ReactNode
  /** Uses the live editor snapshot and appends the returned prose. */
  onContinueWriting?: () => Promise<void>
  /** When set, the button renders DISABLED with this tooltip instead of
   *  running — e.g. "turn on Persona to use this". */
  continueWritingDisabledReason?: string
  /** Insert a generated image at the caret (Phase 6 v2 R10). When set,
   *  the icon-only Generate Image control is shown in the left toolbar. */
  onGeneratedImage?: (result: GenerateImageResult) => void
  /** When true, inline/block math rows are shown in the Aa menu. */
  mathEnabled?: boolean
  onInsertInlineMath?: () => void
  onInsertBlockMath?: () => void
}

// ─── Actions menu row ─────────────────────────────────────────────────────────

interface ActionRowProps {
  icon: LucideIcon
  label: string
  onClick: () => void
  buttonRef?: React.Ref<HTMLButtonElement>
  hasSubmenu?: boolean
  active?: boolean
  onMouseEnter?: () => void
  disabled?: boolean
  busy?: boolean
  tooltip?: string
}

function ActionRow({
  icon: ActionIcon,
  label,
  onClick,
  buttonRef,
  hasSubmenu,
  active,
  onMouseEnter,
  disabled,
  busy,
  tooltip,
}: ActionRowProps) {
  const row = (
    <button
      ref={buttonRef}
      type="button"
      disabled={disabled || busy}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className={cn(
        'text-fg hover:bg-surface-subtle flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg border-none bg-transparent px-2.5 text-left text-sm font-medium',
        active && 'bg-border-subtle',
        (disabled || busy) && 'cursor-not-allowed opacity-50 hover:bg-transparent',
      )}
    >
      <span aria-hidden="true" className="text-fg-muted grid w-5 place-items-center">
        {busy ? (
          <InlineOrb state="searching" aria-hidden />
        ) : (
          <ActionIcon className="size-3.5" strokeWidth={1.75} />
        )}
      </span>
      <span className="flex-1 truncate">{label}</span>
      {hasSubmenu && (
        <ChevronRight className="text-fg-muted size-2.5 shrink-0" strokeWidth={2.25} aria-hidden />
      )}
    </button>
  )
  if (!tooltip) return row
  return (
    <Tooltip content={tooltip} placement="right" className="w-full">
      {row}
    </Tooltip>
  )
}

// ─── EditorFooter ─────────────────────────────────────────────────────────────

export function EditorFooter({
  entry,
  journal = null,
  editor,
  onToggleFavorite,
  onApplyTemplate,
  onAttachmentAdded,
  onInlineImageInserted,
  highlightsEnabled = false,
  goDeeperEnabled = false,
  wordCount = 0,
  renderHighlightsPopover,
  renderGoDeeperPopover,
  onContinueWriting,
  continueWritingDisabledReason,
  onGeneratedImage,
  mathEnabled = false,
  onInsertInlineMath,
  onInsertBlockMath,
}: EditorFooterProps) {
  const { t } = useTranslation('editor')
  const { t: tAi } = useTranslation('ai')
  const imageGenAvailability = useAiImageGenerationEnabled()
  const {
    photoLibraryAvailable,
    insertInlineRfd,
    attachRfd,
    insertInlineFromPhotoLibrary,
    attachFromPhotoLibrary,
  } = useImageInsertPicker()
  const {
    photoLibraryAvailable: videoLibraryAvailable,
    insertInlineRfd: insertInlineVideoRfd,
    attachRfd: attachVideoRfd,
    insertInlineFromPhotoLibrary: insertInlineVideoFromPhotoLibrary,
    attachFromPhotoLibrary: attachVideoFromPhotoLibrary,
  } = useVideoInsertPicker()
  const { attachFiles } = useFilePicker()
  const { templates } = useTemplates()
  const [showActions, setShowActions] = useState(false)
  const [showAiMenu, setShowAiMenu] = useState(false)
  const [showTemplates, setShowTemplates] = useState(false)
  const [showRecorder, setShowRecorder] = useState(false)
  const [showHighlights, setShowHighlights] = useState(false)
  const [showGoDeeper, setShowGoDeeper] = useState(false)
  const [showGenerateImage, setShowGenerateImage] = useState(false)
  const [continueWritingBusy, setContinueWritingBusy] = useState(false)
  const [continueWritingFailed, setContinueWritingFailed] = useState(false)
  /** Sync twin of `continueWritingBusy` — see the click handler. */
  const continueWritingBusyRef = useRef(false)

  // The footer is not remounted when the user switches entries, so a
  // request still in flight for the previous entry would otherwise leave
  // the new entry's button spinning and disabled. The in-flight promise's
  // own `finally` still runs; clearing twice is harmless.
  useEffect(() => {
    continueWritingBusyRef.current = false
    setContinueWritingBusy(false)
    setContinueWritingFailed(false)
    setShowAiMenu(false)
    setShowHighlights(false)
    setShowGoDeeper(false)
    setShowGenerateImage(false)
  }, [entry.id])
  // Exclusive nested pane: only one of Image / Video is open at a time.
  // Hover and click both *open* (never toggle shut) so re-clicking an
  // already-open parent is a no-op. Do not close on parent-row mouseleave
  // — the nested popover uses offset(8) and the mouse must cross that gap.
  const [submenu, setSubmenu] = useState<null | 'image' | 'video'>(null)
  // True while a Photo Library pick is being saved + inserted. We surface a
  // small overlay so the 1-2s lag between PHPicker dismissal and the image
  // landing in the editor doesn't read as "nothing happened".
  const [isInsertingPhoto, setIsInsertingPhoto] = useState(false)
  // Error message surfaced when the file-attach picker rejects a selection
  // (media file mixed in, size cap exceeded, batch too large, etc.).
  // Rendered via a single-button Modal so the dialog matches the rest of
  // the design system instead of falling back to `window.alert`.
  const [attachFilesError, setAttachFilesError] = useState<string | null>(null)
  // Same pattern for the video pickers: VIDEO_TOO_LARGE / bridge errors are
  // surfaced via a single-button modal so the user sees the file name + cap.
  const [videoPickerError, setVideoPickerError] = useState<string | null>(null)
  // Same pattern for the single-image pickers (rfd inline/attach): an
  // IMAGE_TOO_LARGE error on an incompressible/oversized image is surfaced
  // via a single-button modal mirroring the video one. The PHPicker batch
  // path already intercepts + logs oversized items, so it never lands here.
  const [imagePickerError, setImagePickerError] = useState<string | null>(null)
  const insertImageAnchorRef = useRef<HTMLButtonElement | null>(null)
  const insertVideoAnchorRef = useRef<HTMLButtonElement | null>(null)

  /// Highlights + Go-Deeper popovers are anchored via floating-ui and
  /// rendered through <FloatingPortal>, so they escape the editor
  /// column's `overflow-hidden` and visually stack on top of the
  /// neighbouring entries list. Dismiss (click-outside + Esc) is
  /// handled by `useDismiss` — no manual mousedown listeners.
  const highlightsFloat = useFloating({
    open: showHighlights,
    onOpenChange: setShowHighlights,
    placement: 'top-end',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(6),
      flip({ fallbackPlacements: ['top-start', 'bottom-end', 'bottom-start'] }),
      shift({ padding: 8 }),
    ],
  })
  const highlightsDismiss = useDismiss(highlightsFloat.context)
  const { getFloatingProps: getHighlightsFloatingProps } = useInteractions([highlightsDismiss])

  const goDeeperFloat = useFloating({
    open: showGoDeeper,
    onOpenChange: setShowGoDeeper,
    placement: 'top-end',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(6),
      flip({ fallbackPlacements: ['top-start', 'bottom-end', 'bottom-start'] }),
      shift({ padding: 8 }),
    ],
  })
  const goDeeperDismiss = useDismiss(goDeeperFloat.context)
  const { getFloatingProps: getGoDeeperFloatingProps } = useInteractions([goDeeperDismiss])

  /// "+" menu — anchored via floating-ui and rendered through
  /// FloatingPortal so it escapes the editor column's `overflow-hidden`
  /// and visually stacks on top of the entry list on the left. Dismiss
  /// is handled by `useDismiss`, but with a guard so clicks inside the
  /// InsertImage sub-popover do NOT close the parent menu.
  const actionsFloat = useFloating({
    open: showActions,
    onOpenChange: (open) => {
      setShowActions(open)
      if (!open) setSubmenu(null)
    },
    placement: 'top-end',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(6),
      flip({ fallbackPlacements: ['top-start', 'bottom-end', 'bottom-start'] }),
      shift({ padding: 8 }),
    ],
  })
  const actionsDismiss = useDismiss(actionsFloat.context, {
    outsidePress: (event) => {
      // Sub-popovers for "Insert image" / "Insert video" live in their own
      // portals and are semantically children of this menu — clicks there
      // must not collapse the parent.
      const target = event.target as HTMLElement | null
      if (target?.closest('[data-insert-image-popover]')) return false
      if (target?.closest('[data-insert-video-popover]')) return false
      return true
    },
  })
  const { getReferenceProps: getActionsReferenceProps, getFloatingProps: getActionsFloatingProps } =
    useInteractions([actionsDismiss])

  const aiMenuFloat = useFloating({
    open: showAiMenu,
    onOpenChange: setShowAiMenu,
    placement: 'top-start',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(6),
      flip({ fallbackPlacements: ['top-end', 'bottom-start', 'bottom-end'] }),
      shift({ padding: 8 }),
    ],
  })
  const aiMenuDismiss = useDismiss(aiMenuFloat.context, {
    outsidePress: (event) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('[data-editor-footer-ai-pane]')) return false
      return true
    },
  })
  const { getReferenceProps: getAiMenuReferenceProps, getFloatingProps: getAiMenuFloatingProps } =
    useInteractions([aiMenuDismiss])

  const setAiReference = (node: HTMLDivElement | null) => {
    aiMenuFloat.refs.setReference(node)
    highlightsFloat.refs.setReference(node)
    goDeeperFloat.refs.setReference(node)
  }

  // Mirror of the backend `*_MIN_WORDS` floors. Below this we surface a
  // tooltip instead of opening the popover so the user understands why
  // the LLM call would be useless on a 5-word entry.
  const MIN_WORDS = 80
  const wordsRemaining = Math.max(0, MIN_WORDS - wordCount)
  const aiButtonsDisabled = wordCount < MIN_WORDS
  const showImageGen =
    onGeneratedImage != null && imageGenAvailability != null && imageGenAvailability !== 'off'
  const showAiButton =
    highlightsEnabled || goDeeperEnabled || onContinueWriting != null || showImageGen

  const openSubmenu = (next: 'image' | 'video') => {
    setSubmenu(next)
  }

  const closeSubmenu = () => {
    setSubmenu(null)
  }

  const run = (fn: () => void) => {
    fn()
    setShowActions(false)
    setSubmenu(null)
  }

  const handleAttachFiles = async () => {
    if (!entry.id) return
    setShowActions(false)
    setSubmenu(null)
    setIsInsertingPhoto(true)
    try {
      const { results, error } = await attachFiles(entry.id)
      if (error) {
        const msg =
          error.kind === 'media-not-allowed'
            ? t('more.attach_files_error_media', { filename: error.filename })
            : error.kind === 'file-too-large'
              ? t('more.attach_files_error_too_large', {
                  filename: error.filename,
                  maxSizeMb: error.maxSizeMb,
                })
              : error.kind === 'batch-too-large'
                ? t('more.attach_files_error_batch', {
                    count: error.count,
                    max: error.max,
                  })
                : t('more.attach_files_error_unknown', { message: error.message })
        setAttachFilesError(msg)
        return
      }
      if (results.length > 0) await onAttachmentAdded?.()
    } finally {
      setIsInsertingPhoto(false)
    }
  }

  const resolveVideoErrorMessage = (
    error: NonNullable<Awaited<ReturnType<typeof insertInlineVideoRfd>>['error']>,
  ): string => {
    if (error.kind === 'video-too-large') {
      return t('more.video_too_large', {
        filename: error.filename,
        maxSizeMb: error.maxSizeMb,
      })
    }
    return t('more.video_picker_error_unknown', { message: error.message })
  }

  const resolveImageErrorMessage = (
    error: NonNullable<Awaited<ReturnType<typeof insertInlineRfd>>['error']>,
  ): string => {
    if (error.kind === 'image-too-large') {
      return t('more.image_too_large', {
        actualMb: Math.round(error.actualBytes / (1024 * 1024)),
        limitMb: Math.round(error.limitBytes / (1024 * 1024)),
      })
    }
    return t('more.image_picker_error_unknown', { message: error.message })
  }

  const handleInsertVideoAction = async (action: InsertVideoActionId) => {
    setSubmenu(null)
    setShowActions(false)
    if (!entry.id || !editor) return
    const isPhotoLibrary = action === 'photo-library-inline' || action === 'photo-library-attached'
    if (isPhotoLibrary) setIsInsertingPhoto(true)
    try {
      let result: Awaited<ReturnType<typeof insertInlineVideoRfd>>
      switch (action) {
        case 'inline-rfd':
          result = await insertInlineVideoRfd(editor, entry.id)
          break
        case 'attached-rfd':
          result = await attachVideoRfd(entry.id)
          break
        case 'photo-library-inline':
          result = await insertInlineVideoFromPhotoLibrary(editor, entry.id)
          break
        case 'photo-library-attached':
          result = await attachVideoFromPhotoLibrary(entry.id)
          break
      }
      if (result.error) {
        setVideoPickerError(resolveVideoErrorMessage(result.error))
        return
      }
      if (result.rejected.length > 0) {
        setVideoPickerError(
          t('more.video_partially_rejected', {
            count: result.rejected.length,
            names: result.rejected.join(', '),
          }),
        )
      }
      if (result.saved > 0) {
        // Mirror handleInsertImageAction's contract: inline branches fire
        // `onInlineImageInserted` only, attach branches fire `onAttachmentAdded`
        // only. The attachment strip refreshes on its own via the
        // `media-changed` event emitted by `pickVideo` / `pickVideosFromLibrary`,
        // so we don't need to fire both. Double-firing would re-run the
        // EXIF date + location suggestion scans needlessly.
        if (result.insertedInline) {
          await onInlineImageInserted?.()
        } else {
          await onAttachmentAdded?.()
        }
      }
    } finally {
      if (isPhotoLibrary) setIsInsertingPhoto(false)
    }
  }

  const handleInsertImageAction = async (action: InsertImageActionId) => {
    setSubmenu(null)
    setShowActions(false)
    if (!entry.id || !editor) return
    const isPhotoLibrary = action === 'photo-library-inline' || action === 'photo-library-attached'
    if (isPhotoLibrary) setIsInsertingPhoto(true)
    try {
      let result: Awaited<ReturnType<typeof insertInlineRfd>>
      switch (action) {
        case 'inline-rfd':
          result = await insertInlineRfd(editor, entry.id)
          break
        case 'attached-rfd':
          result = await attachRfd(entry.id)
          break
        case 'photo-library-inline':
          // Spinner wraps the entire PHPicker round-trip — the modal hides it
          // while open, then surfaces during the 1-2s save lag the user sees
          // after dismissing the picker.
          result = await insertInlineFromPhotoLibrary(editor, entry.id)
          break
        case 'photo-library-attached':
          result = await attachFromPhotoLibrary(entry.id)
          break
      }
      if (result.error) {
        setImagePickerError(resolveImageErrorMessage(result.error))
        return
      }
      if (result.saved > 0) {
        // Mirror handleInsertVideoAction's contract: inline branches fire
        // `onInlineImageInserted` only, attach branches fire `onAttachmentAdded`
        // only (the attachment strip refreshes via the `media-changed` event).
        if (result.insertedInline) {
          await onInlineImageInserted?.()
        } else {
          await onAttachmentAdded?.()
        }
      }
    } finally {
      if (isPhotoLibrary) setIsInsertingPhoto(false)
    }
  }

  const startContinueWriting = () => {
    if (
      !onContinueWriting ||
      continueWritingBusyRef.current ||
      continueWritingDisabledReason != null
    ) {
      return
    }
    continueWritingBusyRef.current = true
    setContinueWritingFailed(false)
    setContinueWritingBusy(true)
    setShowAiMenu(false)
    void onContinueWriting()
      .catch((error: unknown) => {
        const code = extractAiErrorCode(error)
        const fallback = tAi('user_memory.persona.continue_writing_failed')
        toast(code ? tAi(`error.${code}`, { defaultValue: fallback }) : fallback)
        setContinueWritingFailed(true)
      })
      .finally(() => {
        continueWritingBusyRef.current = false
        setContinueWritingBusy(false)
      })
  }

  const imageGenDisabledReason =
    imageGenAvailability === 'needs_setup'
      ? tAi('image_gen.needs_setup', {
          defaultValue: 'Finish setting up an image provider in Settings → AI.',
        })
      : imageGenAvailability === 'unsupported'
        ? tAi('image_gen.unsupported', {
            defaultValue: "This provider doesn't support image generation.",
          })
        : undefined

  return (
    <div className="border-border-default _editor-footer flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t px-4 py-2 text-xs">
      <div className="flex flex-row items-center gap-0.5 whitespace-nowrap">
        {journal && <EntryJournalBadge journal={journal} entryId={entry.id} />}

        <Tooltip
          content={entry.is_favorite ? t('pills.fav_remove') : t('pills.fav_add')}
          placement="top"
        >
          <Star
            className="mx-1"
            active={entry.is_favorite}
            size={24}
            onClick={onToggleFavorite}
            label={entry.is_favorite ? t('pills.fav_remove') : t('pills.fav_add')}
          />
        </Tooltip>

        {showAiButton && (
          <div
            ref={setAiReference}
            className="shrink-0"
            data-testid="editor-footer-ai"
            {...getAiMenuReferenceProps()}
          >
            <Tooltip
              content={t('pills.ai', { defaultValue: 'AI' })}
              placement="top"
              disabled={showAiMenu || showHighlights || showGoDeeper}
            >
              <Button
                variant="ghost"
                size="sm"
                icon={<AiIcon aria-hidden />}
                loading={continueWritingBusy}
                loadingError={continueWritingFailed}
                announceOnSettle={tAi('announcer.writing_ready')}
                active={showAiMenu || showHighlights || showGoDeeper}
                aria-label={t('pills.ai_aria', { defaultValue: 'AI actions' })}
                aria-expanded={showAiMenu}
                aria-haspopup="menu"
                onClick={() => {
                  setShowActions(false)
                  setSubmenu(null)
                  if (showHighlights || showGoDeeper || showAiMenu) {
                    setShowHighlights(false)
                    setShowGoDeeper(false)
                    setShowAiMenu(false)
                    return
                  }
                  setShowAiMenu(true)
                }}
                className={TOOLBAR_BUTTON_CLASS}
              />
            </Tooltip>

            {showAiMenu && (
              <FloatingPortal>
                <div
                  ref={aiMenuFloat.refs.setFloating}
                  style={aiMenuFloat.floatingStyles}
                  role="menu"
                  aria-label={t('pills.ai_aria', { defaultValue: 'AI actions' })}
                  data-testid="editor-footer-ai-menu"
                  className="border-border-default bg-elevated z-50 w-55 rounded-xl border p-1.5 shadow-lg"
                  {...getAiMenuFloatingProps()}
                >
                  {highlightsEnabled && (
                    <ActionRow
                      icon={Sparkles}
                      label={tAi('highlights.title', { defaultValue: 'Highlights' })}
                      disabled={aiButtonsDisabled}
                      tooltip={
                        aiButtonsDisabled
                          ? tAi('highlights.needs_more_words', { remaining: wordsRemaining })
                          : undefined
                      }
                      onClick={() => {
                        setShowAiMenu(false)
                        setShowGoDeeper(false)
                        setShowHighlights(true)
                      }}
                    />
                  )}
                  {goDeeperEnabled && (
                    <ActionRow
                      icon={Compass}
                      label={tAi('go_deeper.button')}
                      disabled={aiButtonsDisabled}
                      tooltip={
                        aiButtonsDisabled
                          ? tAi('go_deeper.needs_more_words', { remaining: wordsRemaining })
                          : undefined
                      }
                      onClick={() => {
                        setShowAiMenu(false)
                        setShowHighlights(false)
                        setShowGoDeeper(true)
                      }}
                    />
                  )}
                  {onContinueWriting && (
                    <ActionRow
                      icon={WandSparkles}
                      label={tAi('user_memory.persona.continue_writing')}
                      disabled={continueWritingDisabledReason != null}
                      busy={continueWritingBusy}
                      tooltip={
                        continueWritingDisabledReason ??
                        (continueWritingBusy
                          ? tAi('user_memory.persona.continue_writing_busy')
                          : undefined)
                      }
                      onClick={startContinueWriting}
                    />
                  )}
                  {showImageGen && (
                    <ActionRow
                      icon={Palette}
                      label={tAi('image_gen.button', { defaultValue: 'Generate image' })}
                      disabled={imageGenDisabledReason != null}
                      tooltip={imageGenDisabledReason}
                      onClick={() => {
                        setShowAiMenu(false)
                        setShowGenerateImage(true)
                      }}
                    />
                  )}
                </div>
              </FloatingPortal>
            )}

            {showHighlights && (
              <FloatingPortal>
                <div
                  ref={highlightsFloat.refs.setFloating}
                  style={highlightsFloat.floatingStyles}
                  data-editor-footer-ai-pane=""
                  className="z-50"
                  {...getHighlightsFloatingProps()}
                >
                  {renderHighlightsPopover?.(() => setShowHighlights(false))}
                </div>
              </FloatingPortal>
            )}

            {showGoDeeper && (
              <FloatingPortal>
                <div
                  ref={goDeeperFloat.refs.setFloating}
                  style={goDeeperFloat.floatingStyles}
                  data-editor-footer-ai-pane=""
                  className="z-50"
                  {...getGoDeeperFloatingProps()}
                >
                  {renderGoDeeperPopover?.(() => setShowGoDeeper(false))}
                </div>
              </FloatingPortal>
            )}
          </div>
        )}

        {/* "+" — editor actions */}
        <div
          ref={actionsFloat.refs.setReference}
          className="shrink-0"
          {...getActionsReferenceProps()}
        >
          <Tooltip
            content={t('pills.more_aria', { defaultValue: 'More' })}
            placement="top"
            disabled={showActions}
          >
            <Button
              variant="ghost"
              size="sm"
              active={showActions}
              aria-label={t('pills.more_aria', { defaultValue: 'More' })}
              onClick={() => {
                setShowAiMenu(false)
                setShowHighlights(false)
                setShowGoDeeper(false)
                setShowActions((v) => !v)
                setSubmenu(null)
              }}
              className={TOOLBAR_BUTTON_CLASS}
              style={TOOLBAR_ICON_BUTTON_STYLE}
            >
              <Plus className="size-4" aria-hidden />
            </Button>
          </Tooltip>

          {showActions && editor && (
            <FloatingPortal>
              <div
                ref={actionsFloat.refs.setFloating}
                style={actionsFloat.floatingStyles}
                className="border-border-default bg-elevated z-50 w-55 rounded-xl border p-1.5 shadow-lg"
                {...getActionsFloatingProps()}
              >
                {/* Insert group */}
                <div className="text-fg-muted text-2xs px-2.5 pt-1.5 pb-1 font-bold tracking-[0.6px] uppercase">
                  {t('more.insert_heading')}
                </div>
                {onApplyTemplate && (
                  <ActionRow
                    icon={LayoutTemplate}
                    label={t('more.template')}
                    onClick={() => run(() => setShowTemplates(true))}
                    onMouseEnter={closeSubmenu}
                  />
                )}
                <ActionRow
                  icon={Image}
                  label={t('more.insert_image')}
                  buttonRef={insertImageAnchorRef}
                  hasSubmenu
                  active={submenu === 'image'}
                  onMouseEnter={() => openSubmenu('image')}
                  onClick={() => openSubmenu('image')}
                />
                {/* The two legacy image actions ("Inline image" / "Attach image")
                  and the new "From Photo Library (*)" actions all live inside
                  the sub-popover rendered below the Aa group; keeping them
                  out of this list keeps the Aa menu short. */}
                <ActionRow
                  icon={Film}
                  label={t('more.video')}
                  buttonRef={insertVideoAnchorRef}
                  hasSubmenu
                  active={submenu === 'video'}
                  onMouseEnter={() => openSubmenu('video')}
                  onClick={() => openSubmenu('video')}
                />
                <ActionRow
                  icon={Mic}
                  label={t('more.voice_memo')}
                  onClick={() => {
                    setShowRecorder(true)
                    setShowActions(false)
                    setSubmenu(null)
                  }}
                  onMouseEnter={closeSubmenu}
                />
                <ActionRow
                  icon={Paperclip}
                  label={t('more.attach_files')}
                  onClick={() => void handleAttachFiles()}
                  onMouseEnter={closeSubmenu}
                />

                {/* Format group */}
                <div className="text-fg-muted text-2xs px-2.5 pt-2.5 pb-1 font-bold tracking-[0.6px] uppercase">
                  {t('more.format_heading')}
                </div>
                <ActionRow
                  icon={ListOrdered}
                  label={t('more.ordered_list')}
                  onClick={() => run(() => editor.chain().focus().toggleOrderedList().run())}
                  onMouseEnter={closeSubmenu}
                />
                <ActionRow
                  icon={ListChecks}
                  label={t('more.task_list')}
                  onClick={() => run(() => editor.chain().focus().toggleTaskList().run())}
                  onMouseEnter={closeSubmenu}
                />
                <ActionRow
                  icon={TableIcon}
                  label={t('more.table')}
                  onClick={() =>
                    run(() =>
                      editor
                        .chain()
                        .focus()
                        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
                        .run(),
                    )
                  }
                  onMouseEnter={closeSubmenu}
                />
                <ActionRow
                  icon={Code2}
                  label={t('more.code_block')}
                  onClick={() => run(() => editor.chain().focus().toggleCodeBlock().run())}
                  onMouseEnter={closeSubmenu}
                />
                {mathEnabled && onInsertInlineMath && (
                  <ActionRow
                    icon={FunctionSquare}
                    label={t('more.inline_math')}
                    onClick={() => run(onInsertInlineMath)}
                    onMouseEnter={closeSubmenu}
                  />
                )}
                {mathEnabled && onInsertBlockMath && (
                  <ActionRow
                    icon={Sigma}
                    label={t('more.block_math')}
                    onClick={() => run(onInsertBlockMath)}
                    onMouseEnter={closeSubmenu}
                  />
                )}
                <ActionRow
                  icon={Minus}
                  label={t('more.horizontal_rule')}
                  onClick={() => run(() => editor.chain().focus().setHorizontalRule().run())}
                  onMouseEnter={closeSubmenu}
                />
              </div>
            </FloatingPortal>
          )}

          {showTemplates && onApplyTemplate && (
            <TemplatePicker
              templates={templates}
              onSelect={(tmpl) => {
                onApplyTemplate(tmpl)
                setShowTemplates(false)
              }}
              onClose={() => setShowTemplates(false)}
            />
          )}

          <InsertImagePopover
            anchor={insertImageAnchorRef.current}
            open={submenu === 'image'}
            onOpenChange={(open) => {
              if (open) setSubmenu('image')
              else setSubmenu((current) => (current === 'image' ? null : current))
            }}
            onSelect={(action) => void handleInsertImageAction(action)}
            photoLibraryAvailable={photoLibraryAvailable}
          />

          <InsertVideoPopover
            anchor={insertVideoAnchorRef.current}
            open={submenu === 'video'}
            onOpenChange={(open) => {
              if (open) setSubmenu('video')
              else setSubmenu((current) => (current === 'video' ? null : current))
            }}
            onSelect={(action) => void handleInsertVideoAction(action)}
            photoLibraryAvailable={videoLibraryAvailable}
          />

          {isInsertingPhoto && (
            <FloatingPortal>
              <div
                // `pointer-events-auto` (NOT `none`) so the overlay actually
                // swallows clicks during the 1-2s save lag. With `none`,
                // clicks pass through to the editor/sidebar and get
                // dispatched as soon as the spinner unmounts — the user
                // experiences a phantom click on whatever they clicked
                // during the wait.
                className="fixed inset-0 z-1100 flex items-center justify-center bg-black/10"
                aria-live="polite"
                aria-busy="true"
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <div className="bg-elevated border-border-default text-fg flex items-center gap-3 rounded-xl border px-4 py-3 text-sm shadow-lg">
                  <InlineOrb state="searching" aria-hidden />
                  <ShimmerText className="text-sm">{t('more.saving_photo')}</ShimmerText>
                </div>
              </div>
            </FloatingPortal>
          )}
        </div>
      </div>

      {showRecorder && entry.id && (
        <VoiceMemoModal
          entryId={entry.id}
          onSaved={() => {
            void onAttachmentAdded?.()
          }}
          onClose={() => setShowRecorder(false)}
        />
      )}

      {attachFilesError !== null && (
        <Modal onClose={() => setAttachFilesError(null)}>
          <Modal.Header description={attachFilesError}>
            {t('more.attach_files_error_title')}
          </Modal.Header>
          <Modal.Footer>
            <Button variant="primary" size="sm" onClick={() => setAttachFilesError(null)}>
              {t('more.attach_files_error_ok')}
            </Button>
          </Modal.Footer>
        </Modal>
      )}

      {videoPickerError !== null && (
        <Modal onClose={() => setVideoPickerError(null)}>
          <Modal.Header description={videoPickerError}>
            {t('more.video_picker_error_title')}
          </Modal.Header>
          <Modal.Footer>
            <Button variant="primary" size="sm" onClick={() => setVideoPickerError(null)}>
              {t('more.attach_files_error_ok')}
            </Button>
          </Modal.Footer>
        </Modal>
      )}

      {imagePickerError !== null && (
        <Modal onClose={() => setImagePickerError(null)}>
          <Modal.Header description={imagePickerError}>
            {t('more.image_picker_error_title')}
          </Modal.Header>
          <Modal.Footer>
            <Button variant="primary" size="sm" onClick={() => setImagePickerError(null)}>
              {t('more.attach_files_error_ok')}
            </Button>
          </Modal.Footer>
        </Modal>
      )}

      {showGenerateImage && onGeneratedImage && (
        <GenerateImageDialog
          entryId={entry.id}
          initialPrompt=""
          getEntryText={() => editor?.getText() ?? ''}
          onInserted={(result) => {
            setShowGenerateImage(false)
            onGeneratedImage(result)
          }}
          onCancel={() => setShowGenerateImage(false)}
        />
      )}

      <div className="flex flex-row items-center gap-1 whitespace-nowrap">
        {/* Tags — wired via add_tag_to_entry / remove_tag_from_entry */}
        <EntryTagsPill entryId={entry.id} />
      </div>
    </div>
  )
}
