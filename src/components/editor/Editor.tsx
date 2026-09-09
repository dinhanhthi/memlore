import { useEditor, EditorContent } from '@tiptap/react'
import type { Editor as TipTapEditor, Extension } from '@tiptap/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { convertFileSrc } from '@tauri-apps/api/core'
import {
  getEntry,
  savePastedImage,
  updateEntryDate,
  markEntryDateUserEdited,
  updateEntryLocation,
  deleteMedia,
  updateMediaInsertionMode,
  listMediaForEntry,
} from '../../lib/tauri'
import type { GenerateImageResult, MediaRow } from '../../lib/tauri'
import { useEntryDateSuggestion } from '../../hooks/useEntryDateSuggestion'
import { applyEntryWeather } from '../../hooks/applyEntryWeather'
import { EntryMetadataSuggestionModal } from './EntryMetadataSuggestionModal'
import type { EntryMetadataSuggestionPayload } from './EntryMetadataSuggestionModal'
import { useEditorMetricsStore } from '../../stores/editorMetricsStore'
import { useEntryAttachments } from '../../hooks/useEntryAttachments'
import { ImageModePopover } from './ImageModePopover'
import { AttachmentStrip } from './AttachmentStrip'
import { AudioPlaybackModal } from '../media/AudioPlaybackModal'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { MediaZoomContext } from './MediaZoomContext'
import { MediaGalleryCarousel, type CarouselMediaItem } from '../media/MediaGalleryCarousel'
import { BODY_OVERLAY_HOST_ID } from '../../lib/overlayHost'
import { FileViewerModal } from '../media/FileViewerModal'
import { downloadAttachment } from '../../lib/attachmentDownload'
import { toast } from '../../lib/toast'
import {
  createInlineMediaDeletionTracker,
  type InlineMediaDeletionTracker,
} from '../../lib/inlineMediaDeletionTracker'
import Collaboration from '@tiptap/extension-collaboration'
import Placeholder from '@tiptap/extension-placeholder'
import { buildSharedExtensions } from './sharedExtensions'
import * as Y from 'yjs'
import { EditorHeader } from './EditorHeader'
import { EditorFooter } from './EditorFooter'
import { EntryLocationRow } from './EntryLocationRow'
import { EditorBubbleMenu } from './BubbleMenu'
import { ImageBubbleMenu } from './ImageBubbleMenu'
import { VideoBubbleMenu } from './VideoBubbleMenu'
import { MathEditModal } from './MathEditModal'
import { SlashMenuExtension } from './extensions/SlashMenu'
import { EmojiShortcodes } from './extensions/EmojiShortcodes'
import { EditorDropIndicator } from './extensions/EditorDropIndicator'

import { useEditorMathEnabled } from '../../hooks/useEditorMathEnabled'
import { useEditorEmojiShortcodesEnabled } from '../../hooks/useEditorEmojiShortcodesEnabled'
import { useEditorFixedTitleEnabled } from '../../hooks/useEditorFixedTitleEnabled'
import { useEditorJustifyEnabled } from '../../hooks/useEditorJustifyEnabled'
import { useEditorRightToLeftEnabled } from '../../hooks/useEditorRightToLeftEnabled'
import { useEditorTypography } from '../../hooks/useEditorTypography'
import { setMathEditRequestHandler, type MathEditRequest } from '../../lib/editorMath'
import { Find } from './extensions/Find'
import { useImagePicker } from '../../hooks/useImagePicker'
import { useEntryLocationSuggestion } from '../../hooks/useEntryLocationSuggestion'
import { useInvisibleLockStore } from '../../stores/invisibleLockStore'
import { useRestoredScroll } from '../../hooks/useRestoredScroll'
import { tabScrollKey } from '../../lib/tabScrollPositions'
import { useTabStore } from '../../stores/tabStore'
import { cn } from '../../lib/cn'
import { editorContentColumnClass, editorContentWrapperClass } from '../../lib/editorLayout'
import { useEditorDistractionStore } from '../../stores/editorDistractionStore'
import {
  setEditorMediaStripCollapsed,
  useEditorMediaStripCollapsed,
} from '../../hooks/useEditorMediaStripCollapsed'
import {
  initialDistractionMediaStripCollapsed,
  resolveMediaStripCollapsed,
  shouldResetDistractionMediaStripSession,
} from '../../lib/editorMediaStripCollapse'
import type { Template } from '../../types/template'
import type { Entry } from '../../types/entry'
import type { Journal } from '../../types/journal'

// Module-level tracker so pending deletes survive Editor unmount (entry switch
// sets `doc` to null, which unmounts this component). Callbacks are rebound
// every render via this bag so a remount does not close over dead refs.
const mediaDeletedListeners = {
  refetch: () => {},
  refresh: () => {},
  cover: () => {},
}
let sharedMediaDeletionTracker: InlineMediaDeletionTracker | null = null

function getSharedMediaDeletionTracker(): InlineMediaDeletionTracker {
  if (sharedMediaDeletionTracker === null) {
    sharedMediaDeletionTracker = createInlineMediaDeletionTracker({
      deleteMedia,
      onDeleted: () => {
        mediaDeletedListeners.refetch()
        mediaDeletedListeners.refresh()
        mediaDeletedListeners.cover()
      },
    })
  }
  return sharedMediaDeletionTracker
}

function removeMediaNodesById(editor: TipTapEditor, mediaId: string) {
  const { state } = editor
  const positions: { from: number; to: number }[] = []
  state.doc.descendants((node, pos) => {
    if (node.attrs?.['data-media-id'] === mediaId) {
      positions.push({ from: pos, to: pos + node.nodeSize })
    }
    return true
  })
  if (positions.length === 0) return
  const tr = state.tr
  // Delete from the end backwards so earlier positions remain valid.
  for (let i = positions.length - 1; i >= 0; i--) {
    tr.delete(positions[i].from, positions[i].to)
  }
  editor.view.dispatch(tr)
}

interface EditorProps {
  doc: Y.Doc
  editable: boolean
  onUpdate: () => void
  onApplyTemplate?: (template: Template) => void
  /**
   * When set, the editor eagerly applies this template's content once the
   * TipTap instance is ready and the editor is empty. Used by
   * `EntryList` → `TemplatePicker` to initialise a freshly-created entry
   * with the chosen template body. Consumed exactly once per mount.
   */
  initialTemplate?: Template | null
  /**
   * When set, the editor eagerly applies this HTML once the TipTap
   * instance is ready and the editor is empty. Used by Daily Chat's
   * "Save as entry" flow to seed a freshly-created entry with the
   * AI-drafted markdown (already converted to HTML by the caller).
   * Consumed exactly once per mount, mutually exclusive with
   * `initialTemplate` in practice (a new entry comes from one source).
   */
  initialChatDraftHtml?: string | null
  /** Append (not seed) — inserts at the end of an existing entry, e.g. Daily Chat
   *  "Update the entry". Unlike `initialChatDraftHtml` (which seeds an empty doc),
   *  this inserts after existing content. The `id` is a nonce consumed by the
   *  effect to dedupe (StrictMode/HMR). */
  initialChatAppendHtml?: { id: string; html: string } | null
  entryId?: string | null
  // Phase 3.5 — Chunk D2. The toolbar is now a metadata-rich pill bar that
  // needs the current entry, its parent journal, and the action hooks the
  // EditorPanel owns. When not provided (read-only preview use-cases), the
  // toolbar simply does not render.
  entry?: Entry | null
  journal?: Journal | null
  onEmotionPickerOpen?: () => void
  onLocationSelect?: (
    lat: number | null,
    lng: number | null,
    label: string | null,
    address: string | null,
  ) => void
  onRefetchWeather?: () => void
  onToggleFavorite?: () => void
  /**
   * Optional slot rendered above the scrollable ProseMirror canvas.
   * Used by EditorPanel to pin the entry title (and title-adjacent
   * affordances) while only the body content scrolls.
   */
  titleSlot?: React.ReactNode
  /** Called once when the TipTap editor instance is ready. */
  onEditorReady?: (editor: TipTapEditor) => void
  /** Called after a media node is deleted to flush the save immediately. */
  onImmediateSave?: () => void
  /**
   * Called after the entry's image OR video media list changes (any
   * insert or remove, inline OR attached). EditorPanel uses this to
   * refetch the entry so a freshly-set `cover_media_id` (via
   * `set_cover_if_unset_for_image_or_video` on insert — videos now also
   * become covers via their extracted poster JPEG) or a cleared cover
   * (via the `clear_entry_cover_on_media_delete` DB trigger on remove)
   * propagates into the entry-list card on the left panel.
   */
  onCoverMaybeChanged?: () => void
  // ── AI affordance slots (forwarded straight to <EditorFooter/>) ──
  highlightsEnabled?: boolean
  goDeeperEnabled?: boolean
  wordCount?: number
  renderHighlightsPopover?: (close: () => void) => React.ReactNode
  renderGoDeeperPopover?: (close: () => void) => React.ReactNode
  onRewriteSelection?: (selectedText: string) => Promise<string>
  /** Renders Rewrite / Continue disabled with this tooltip instead of hiding them. */
  proseVoiceDisabledReason?: string
  onContinueWriting?: (context: string) => Promise<string>
  /** Insert a generated AI image at the caret (footer icon). */
  onGeneratedImage?: (result: GenerateImageResult) => void
  /** Pre-loaded math extensions — must be ready before Yjs binds when math is on. */
  mathExtensions?: Extension[]
}

export function Editor({
  doc,
  editable,
  onUpdate,
  onApplyTemplate,
  initialTemplate,
  initialChatDraftHtml,
  initialChatAppendHtml,
  entryId,
  entry,
  journal,
  onEmotionPickerOpen,
  onLocationSelect,
  onRefetchWeather,
  onToggleFavorite,
  titleSlot,
  onEditorReady,
  onImmediateSave,
  onCoverMaybeChanged,
  highlightsEnabled,
  goDeeperEnabled,
  wordCount,
  renderHighlightsPopover,
  renderGoDeeperPopover,
  onRewriteSelection,
  onContinueWriting,
  proseVoiceDisabledReason,
  onGeneratedImage,
  mathExtensions = [],
}: EditorProps) {
  const { t } = useTranslation('editor')
  const mathEnabled = useEditorMathEnabled()
  const emojiShortcodesEnabled = useEditorEmojiShortcodesEnabled()
  const fixedTitleEnabled = useEditorFixedTitleEnabled()
  const justifyEnabled = useEditorJustifyEnabled()
  const rightToLeftEnabled = useEditorRightToLeftEnabled()
  const typography = useEditorTypography()
  const distractionMode = useEditorDistractionStore((s) => s.distractionMode)
  const [mathEdit, setMathEdit] = useState<MathEditRequest | null>(null)
  const activeVaultId = useInvisibleLockStore((s) => s.activeVaultId)

  useEffect(() => {
    setMathEditRequestHandler(setMathEdit)
  }, [])

  // Keep a stable ref to the latest onUpdate so TipTap's callback (created once)
  // always calls the most recent version without needing to recreate the editor.
  const onUpdateRef = useRef(onUpdate)
  onUpdateRef.current = onUpdate

  // Keep a stable ref to entryId so handlePaste always sees the latest.
  const entryIdRef = useRef(entryId)
  entryIdRef.current = entryId

  // ── A1.3: EXIF date suggestion ────────────────────────────────────────────
  // Suppression now comes from a DURABLE backend column
  // (`entry.entry_date_user_edited`) rather than the in-memory store flag,
  // which reset on every entry navigation and caused the modal to re-pop
  // forever after a user had already chosen a date. The store flag is
  // kept as a one-render-cycle local override so the modal can close
  // immediately on confirm/dismiss without waiting for the entry refetch.
  const entryDateUserEditedSession = useEditorMetricsStore((s) => s.entryDateUserEdited)
  const setEntryDateUserEdited = useEditorMetricsStore((s) => s.setEntryDateUserEdited)
  const entryDateUserEdited = entryDateUserEditedSession || (entry?.entry_date_user_edited ?? false)
  const { suggestion, triggerCheck } = useEntryDateSuggestion({
    entryId: entryId ?? null,
    entryDateUserEdited,
  })
  // React to suggestion state changes — single date: silent update; multi:
  // open the unified metadata modal (date tab visible).
  useEffect(() => {
    if (entryDateUserEdited) return
    if (suggestion.kind === 'single' && entryId) {
      // Silent path does NOT mark the flag — user is re-prompted on next
      // batch of new EXIF dates. Only explicit modal/pill interaction
      // sets the durable flag (see modal `onConfirm` / `onClose` + the
      // date pill's manual edit path in EditorHeader).
      void updateEntryDate(entryId, suggestion.date)
    }
  }, [suggestion, entryId, entryDateUserEdited])

  // Keep a stable ref to triggerCheck so the paste handler (created once) can
  // call the latest version without recreating the editor.
  const triggerCheckRef = useRef(triggerCheck)
  triggerCheckRef.current = triggerCheck

  // ── Phase 3: EXIF location suggestion (mirrors the date flow above) ───────
  const entryLocationUserEdited = useEditorMetricsStore((s) => s.entryLocationUserEdited)
  const setEntryLocationUserEdited = useEditorMetricsStore((s) => s.setEntryLocationUserEdited)
  const { suggestion: locationSuggestion, triggerCheck: triggerLocationCheck } =
    useEntryLocationSuggestion({
      entryId: entryId ?? null,
      entryLocationUserEdited,
    })
  // Single → silent apply; multi → open the unified modal.
  //
  // Suppression: the in-memory `entryLocationUserEdited` flag covers the
  // current session, but it resets when the user closes the entry. To make
  // the suppression DURABLE across navigation we ALSO check whether the
  // entry already has coordinates set in the database (`entry.latitude`
  // and `entry.longitude`). If it does, the user has either explicitly
  // chosen a location previously or accepted a prior suggestion — either
  // way, don't re-prompt.
  const entryHasLocation = entry?.latitude != null && entry?.longitude != null
  useEffect(() => {
    if (entryLocationUserEdited) return
    if (entryHasLocation) return
    if (locationSuggestion.kind === 'single' && entryId) {
      void (async () => {
        try {
          const current = await getEntry(entryId, activeVaultId)
          const existingLabel = current?.location_label ?? null
          const existingAddress = current?.location_address ?? null
          await updateEntryLocation(
            entryId,
            locationSuggestion.location.latitude,
            locationSuggestion.location.longitude,
            existingLabel,
            existingAddress,
          )
          if (entry?.entry_date != null) {
            await applyEntryWeather(
              entryId,
              locationSuggestion.location.latitude,
              locationSuggestion.location.longitude,
              entry.entry_date,
            )
          }
          setEntryLocationUserEdited(true)
        } catch (err) {
          console.error('Failed to apply EXIF location silently:', err)
        }
      })()
    }
  }, [
    locationSuggestion,
    entryId,
    entryLocationUserEdited,
    entryHasLocation,
    activeVaultId,
    setEntryLocationUserEdited,
  ])

  // ── Unified metadata-suggestion modal visibility ───────────────────────────
  //
  // Single source of truth replacing the old `showDateModal` /
  // `showLocationModal` pair. The modal opens whenever either of the
  // two suggestion hooks reports a multi-candidate set AND that side
  // is not already suppressed (in-memory flag, durable backend flag,
  // or — for location — entry already has coords). Closing the modal
  // marks BOTH sides' user-edited flags so the user is never stuck
  // dismissing the same thing twice.
  const showDateInModal = !entryDateUserEdited && suggestion.kind === 'multi'
  const showLocationInModal =
    !entryLocationUserEdited && !entryHasLocation && locationSuggestion.kind === 'multi'
  const showMetadataModal = showDateInModal || showLocationInModal
  const modalDates = showDateInModal && suggestion.kind === 'multi' ? suggestion.dates : []
  const modalLocations =
    showLocationInModal && locationSuggestion.kind === 'multi' ? locationSuggestion.locations : []

  // Stable ref so the same insert callbacks that fire the date trigger also
  // fire the location trigger without re-creating closures every render.
  const triggerLocationCheckRef = useRef(triggerLocationCheck)
  triggerLocationCheckRef.current = triggerLocationCheck

  const { pickInlineImage, pickAttachedImage } = useImagePicker()

  // ── Paste mode-picker state ───────────────────────────────────────────────
  const [pastePopoverAnchor, setPastePopoverAnchor] = useState<DOMRect | null>(null)
  const [pendingPasteImages, setPendingPasteImages] = useState<
    { mediaId: string; localPath: string }[]
  >([])
  const [editorScrollTarget, setEditorScrollTarget] = useState<HTMLDivElement | null>(null)
  const editorScrollRestoreRef = useRef<HTMLDivElement | null>(null)
  const tabId = useTabStore((s) => s.activeTabId)
  useRestoredScroll(
    editorScrollRestoreRef,
    tabId && entryId ? tabScrollKey(tabId, 'editor', entryId) : null,
  )

  // ── Attachment strip ──────────────────────────────────────────────────────
  // Use the canonical `entryId` prop (not `entry?.id`) so the strip always
  // uses the stable identifier even during re-renders when a new entry is loading.
  const attachments = useEntryAttachments(entryId ?? undefined)

  // Persisted collapse preference for the attachment strip (global across
  // entries; default collapsed). Distraction free mode re-collapses on enter
  // via session state without mutating the preference until the user toggles.
  const userMediaStripCollapsed = useEditorMediaStripCollapsed()
  const [dfMediaStripCollapsed, setDfMediaStripCollapsed] = useState(
    initialDistractionMediaStripCollapsed,
  )
  const prevDistractionModeRef = useRef(distractionMode)

  useEffect(() => {
    if (shouldResetDistractionMediaStripSession(distractionMode, prevDistractionModeRef.current)) {
      setDfMediaStripCollapsed(initialDistractionMediaStripCollapsed())
    }
    prevDistractionModeRef.current = distractionMode
  }, [distractionMode])

  const isMediaStripCollapsed = resolveMediaStripCollapsed(
    userMediaStripCollapsed,
    distractionMode,
    dfMediaStripCollapsed,
  )

  const handleMediaStripCollapsedChange = useCallback(
    (next: boolean) => {
      if (distractionMode) {
        setDfMediaStripCollapsed(next)
      }
      void setEditorMediaStripCollapsed(next)
    },
    [distractionMode],
  )

  // ── Attachment strip remove confirmation ─────────────────────────────────
  const [confirmRemoveMediaId, setConfirmRemoveMediaId] = useState<string | null>(null)
  const [playingAudioId, setPlayingAudioId] = useState<string | null>(null)
  const [viewingFileId, setViewingFileId] = useState<string | null>(null)

  // ── Carousel / all-images state ───────────────────────────────────────────
  const [allMedia, setAllMedia] = useState<MediaRow[]>([])
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)

  // Slides for the shared media carousel. No `entry` metadata: the strip is
  // single-entry, so the carousel drops its footer and "Open in Entries".
  const carouselItems = useMemo<CarouselMediaItem[]>(
    () =>
      allMedia.map((m) => ({
        id: m.id,
        fileType: m.file_type,
        label: m.file_name,
      })),
    [allMedia],
  )

  // Close any open media modal when the user switches to a different entry —
  // the open mediaId is stale once we navigate away.
  useEffect(() => {
    setPlayingAudioId(null)
    setViewingFileId(null)
    setLightboxIndex(null)
  }, [entryId])

  const refreshAllMedia = useCallback(() => {
    if (!entryId) {
      setAllMedia([])
      return
    }
    // Lightbox now hosts both images AND videos (videos can only be played
    // there — the attachment strip just shows a static thumbnail with a
    // Play hover icon that calls into handleZoom). Audio + generic files
    // stay out: they have their own modals (AudioPlaybackModal, FileViewerModal).
    listMediaForEntry(entryId, undefined, activeVaultId)
      .then((rows) =>
        setAllMedia(
          rows.filter((r) => r.file_type.startsWith('image/') || r.file_type.startsWith('video/')),
        ),
      )
      .catch(() => {})
  }, [entryId, activeVaultId])

  // Fetch/refresh the full image list whenever entryId changes.
  useEffect(() => {
    refreshAllMedia()
  }, [refreshAllMedia])

  const handleZoom = useCallback(
    (mediaId: string) => {
      const idx = allMedia.findIndex((m) => m.id === mediaId)
      if (idx !== -1) setLightboxIndex(idx)
    },
    [allMedia],
  )

  // Keep a stable ref to pendingPasteImages for the dismiss handler (created once inside useEditor).
  const pendingPasteImagesRef = useRef(pendingPasteImages)
  pendingPasteImagesRef.current = pendingPasteImages

  // Unmount cleanup: if the editor unmounts while the ImageModePopover is still
  // open (e.g. user switches to another entry), delete any pending paste images
  // so they don't become permanently orphaned DB rows and on-disk files.
  useEffect(() => {
    return () => {
      const pending = pendingPasteImagesRef.current
      if (pending.length > 0) {
        void Promise.all(pending.map(({ mediaId }) => deleteMedia(mediaId)))
      }
    }
  }, [])

  // Keep a stable ref to attachments.refetch so the slash-menu handler
  // (created once inside useEditor) always calls the latest version.
  const attachmentsRefetchRef = useRef(attachments.refetch)
  attachmentsRefetchRef.current = attachments.refetch
  // Same stability trick for onCoverMaybeChanged — the slash-menu closure
  // is captured once, but the parent may pass a fresh callback each render.
  const onCoverMaybeChangedRef = useRef(onCoverMaybeChanged)
  onCoverMaybeChangedRef.current = onCoverMaybeChanged

  // Snapshot the ProseMirror selection at paste time so inline images are
  // always inserted at the original paste position, even if the user moves
  // the caret while the mode-picker popover is open.
  const pasteSelectionRef = useRef<number | null>(null)

  const handlePasteModeSelect = async (mode: 'inline' | 'attached') => {
    if (mode === 'inline') {
      for (const { mediaId, localPath } of pendingPasteImages) {
        if (editor) {
          // Restore the original paste position before each insertion so
          // burst-paste images land sequentially from the caret, not at
          // whatever position the user moved to during the popover.
          const pos = pasteSelectionRef.current
          const chain = editor.chain()
          if (pos !== null) {
            chain.focus().setTextSelection(pos)
          } else {
            chain.focus()
          }
          chain
            .setImage({
              src: convertFileSrc(localPath),
              'data-media-id': mediaId,
            } as Parameters<ReturnType<typeof editor.chain>['setImage']>[0])
            .run()
        }
      }
    } else {
      await Promise.allSettled(
        pendingPasteImages.map(({ mediaId }) => updateMediaInsertionMode(mediaId, 'attached')),
      )
      attachments.refetch()
      refreshAllMedia()
    }
    pasteSelectionRef.current = null
    setPastePopoverAnchor(null)
    setPendingPasteImages([])
    // Refresh after inline paste so newly inserted images appear in lightbox.
    refreshAllMedia()
    // Any image that just landed (inline or attached) may have set
    // `cover_media_id` on the server — refetch the entry so the
    // entry-list card cover thumbnail catches up.
    if (pendingPasteImages.length > 0) onCoverMaybeChanged?.()
  }

  const handlePasteDismiss = async () => {
    // Use allSettled so a single failing deleteMedia (e.g. already-deleted
    // row) does not block state cleanup and leave the popover stuck.
    await Promise.allSettled(
      pendingPasteImagesRef.current.map(({ mediaId }) => deleteMedia(mediaId)),
    )
    pasteSelectionRef.current = null
    setPastePopoverAnchor(null)
    setPendingPasteImages([])
  }

  const editor = useEditor(
    {
      extensions: [
        ...buildSharedExtensions({ mathExtensions }),
        EditorDropIndicator,
        Collaboration.configure({ document: doc, field: 'default' }),
        Placeholder.configure({ placeholder: t('placeholder') }),
        Find,
        ...(emojiShortcodesEnabled ? [EmojiShortcodes] : []),
        SlashMenuExtension.configure({
          onInsertInlineMath: () => setMathEdit({ mode: 'insert-inline', latex: '' }),
          onInsertBlockMath: () => setMathEdit({ mode: 'insert-block', latex: '' }),
          onInsertImage: (ed) => {
            const id = entryIdRef.current
            if (!id) return
            void pickInlineImage(ed, id).then((result) => {
              if (result.saved > 0) onCoverMaybeChangedRef.current?.()
            })
          },
          onAttachImage: () => {
            const id = entryIdRef.current
            if (!id) return
            void pickAttachedImage(id).then((result) => {
              if (result.saved > 0) {
                attachmentsRefetchRef.current()
                onCoverMaybeChangedRef.current?.()
              }
            })
          },
        }),
      ],
      editable,
      editorProps: {
        handlePaste(view, event) {
          const currentEntryId = entryIdRef.current
          if (!currentEntryId) return false
          const items = event.clipboardData?.items
          if (!items) return false

          // Collect ALL image items to support burst-paste (multiple images).
          const imageItems = Array.from(items).filter((i) => i.type.startsWith('image/'))
          if (imageItems.length === 0) return false

          // Capture caret position synchronously before any async work.
          const coords = view.coordsAtPos(view.state.selection.anchor)
          const caretRect = new DOMRect(coords.left, coords.top, 0, coords.bottom - coords.top)
          // Snapshot the anchor position so inline insertions land at the paste
          // point even if the user moves the caret while the popover is open.
          pasteSelectionRef.current = view.state.selection.anchor

          // Route the pasted bytes through the same DB + upload pipeline as the
          // file picker, so the media row + encrypted sync work identically.
          //
          // Performance note: Tauri v2 serializes `Vec<u8>` parameters as a JSON
          // number array across the IPC boundary, roughly 4× the raw byte size.
          // For pasted screenshots this is a one-shot cost the user can absorb;
          // for multi-MB bursts we could switch to a Channel<Uint8Array> or an
          // fs-plugin temp-file path when the payload grows large enough to
          // matter. Measured thresholds live in docs/plans/phase-3.
          void (async () => {
            const results = await Promise.allSettled(
              imageItems.map(async (item) => {
                const blob = item.getAsFile()
                if (!blob) throw new Error('Could not read clipboard image')
                const buf = new Uint8Array(await blob.arrayBuffer())
                return savePastedImage(
                  currentEntryId,
                  Array.from(buf),
                  blob.type || 'image/png',
                  'inline',
                )
              }),
            )

            const saved = results
              .filter(
                (r): r is PromiseFulfilledResult<{ mediaId: string; localPath: string }> =>
                  r.status === 'fulfilled',
              )
              .map((r) => r.value)

            const failed = results.filter(
              (r): r is PromiseRejectedResult => r.status === 'rejected',
            )
            if (failed.length > 0) {
              // Parse IMAGE_TOO_LARGE out of the rejection reasons so the
              // failure isn't silently swallowed. Paste errors are less
              // user-critical than picker errors (the user can re-pick from
              // disk), so we log a clear console message rather than opening
              // a modal — matching the existing paste-rejection pattern.
              for (const r of failed) {
                const reason: unknown = r.reason
                const raw =
                  typeof reason === 'string'
                    ? reason
                    : reason instanceof Error
                      ? reason.message
                      : String(reason)
                if (raw.startsWith('IMAGE_TOO_LARGE:')) {
                  // eslint-disable-next-line no-console
                  console.warn('[Editor] pasted image rejected as too large:', raw)
                } else {
                  // eslint-disable-next-line no-console
                  console.error('[Editor] paste image failed to save:', raw)
                }
              }
            }

            if (saved.length === 0) return

            // Trigger EXIF date + location suggestion checks now that media
            // rows exist. Fire-and-forget here (no spinner) — paste opens the
            // ImageModePopover instead, so we don't need to await.
            void triggerCheckRef.current()
            void triggerLocationCheckRef.current()

            // Open the mode-picker popover anchored to the caret.
            setPastePopoverAnchor(caretRect)
            setPendingPasteImages(saved)
          })()

          // Prevent TipTap from handling the paste as an inline base64 image
          // (which would bypass our media pipeline + cloud upload).
          return true
        },
      },
      onUpdate: () => {
        // Defer to a microtask so we never call setState on a parent
        // during the parent's render (e.g. during Yjs collaboration sync
        // on mount). Fixes React warning:
        // "Cannot update a component while rendering a different component".
        queueMicrotask(() => onUpdateRef.current())
      },
      onContentError: ({ error }) => {
        console.error('[Editor] Yjs/content schema mismatch:', error)
      },
    },
    [doc, mathExtensions, emojiShortcodesEnabled],
  )

  const handleMathConfirm = useCallback(
    (latex: string) => {
      if (!editor || !mathEdit) return
      interface MathChain {
        insertInlineMath: (attrs: { latex: string }) => MathChain
        insertBlockMath: (attrs: { latex: string }) => MathChain
        updateInlineMath: (attrs: { latex: string }) => MathChain
        updateBlockMath: (attrs: { latex: string }) => MathChain
        setNodeSelection: (pos: number) => MathChain
        focus: () => MathChain
        run: () => boolean
      }
      const chain = editor.chain() as unknown as MathChain
      const focused = chain.focus()
      switch (mathEdit.mode) {
        case 'insert-inline':
          focused.insertInlineMath({ latex }).run()
          break
        case 'insert-block':
          focused.insertBlockMath({ latex }).run()
          break
        case 'edit-inline':
          if (mathEdit.pos !== undefined) {
            focused.setNodeSelection(mathEdit.pos).updateInlineMath({ latex }).run()
          }
          break
        case 'edit-block':
          if (mathEdit.pos !== undefined) {
            focused.setNodeSelection(mathEdit.pos).updateBlockMath({ latex }).run()
          }
          break
      }
      setMathEdit(null)
    },
    [editor, mathEdit],
  )

  const onEditorReadyRef = useRef(onEditorReady)
  onEditorReadyRef.current = onEditorReady
  useEffect(() => {
    if (editor) onEditorReadyRef.current?.(editor)
  }, [editor])

  // Keep the attach strip and lightbox media list in sync with inline media
  // inserted by ANY path (paste, slash menu, image picker, AI generate,
  // drag/drop) by watching the editor's doc for changes in the set of
  // `data-media-id` node attributes. Without this, only the explicit
  // attached-image and inline-paste paths refetch, so inline images inserted
  // via the slash menu or `GenerateImageButton` would not appear in the
  // bottom strip until the user navigated away and back.
  //
  // Refs are used for the callbacks so the effect doesn't re-subscribe on
  // every parent render — `attachments` and `refreshAllMedia` are recreated
  // each tick.
  const prevMediaIdsRef = useRef<string>('')
  const refreshAllMediaRef = useRef(refreshAllMedia)
  refreshAllMediaRef.current = refreshAllMedia
  // Tracks inline media nodes removed from the doc and deletes their backing
  // media after the entry's next durable save (see the util). Module-level so
  // pending ids survive this component unmounting on entry switch.
  mediaDeletedListeners.refetch = () => attachmentsRefetchRef.current()
  mediaDeletedListeners.refresh = () => refreshAllMediaRef.current()
  mediaDeletedListeners.cover = () => onCoverMaybeChangedRef.current?.()
  const mediaDeletionTrackerRef = useRef<InlineMediaDeletionTracker>(
    getSharedMediaDeletionTracker(),
  )
  useEffect(() => {
    if (!editor) return
    const tracker = mediaDeletionTrackerRef.current
    const recompute = () => {
      const currentSet = new Set<string>()
      editor.state.doc.descendants((node) => {
        const id = node.attrs?.['data-media-id']
        if (typeof id === 'string' && id.length > 0) currentSet.add(id)
        return true
      })
      if (entryId) tracker?.observe(entryId, currentSet)

      const next = [...currentSet].sort().join(',')
      if (next !== prevMediaIdsRef.current) {
        prevMediaIdsRef.current = next
        attachmentsRefetchRef.current()
        refreshAllMediaRef.current()
      }
    }
    // Reset the signature + tracker baseline so the first run for a new
    // editor/entry seeds without treating the loaded doc as removals. Does NOT
    // cancel pending deletions from the previous editor instance of the same
    // entry (undo grace is preserved across a settings-driven editor swap).
    prevMediaIdsRef.current = ''
    tracker?.resetBaseline()
    recompute()
    editor.on('update', recompute)
    return () => {
      editor.off('update', recompute)
    }
  }, [editor, entryId])

  // Keep a stable ref to onApplyTemplate so the initial-template effect
  // below doesn't re-run every time the callback identity changes (it can
  // change on every entry metadata update through EditorPanel).
  const onApplyTemplateRef = useRef(onApplyTemplate)
  onApplyTemplateRef.current = onApplyTemplate

  // Chunk F (redesign) — apply the pending TemplatePicker selection once
  // the editor is ready, but only if the doc is still empty. Guarded by a
  // ref so HMR / re-renders don't reapply. `t` is in the deps because the
  // predefined-template branch reads i18n content; the appliedTemplateKey
  // guard prevents clobbering edits if the user changes language after
  // applying.
  const appliedTemplateKey = useRef<string | null>(null)
  useEffect(() => {
    if (!editor || !initialTemplate) return
    const key = `${entryId ?? ''}::${initialTemplate.id}`
    if (appliedTemplateKey.current === key) return
    if (!editor.isEmpty) {
      appliedTemplateKey.current = key
      return
    }

    let htmlBody: string | null = null
    if (initialTemplate.is_predefined) {
      // Predefined templates resolve their HTML body through i18n so the same
      // row renders in whichever supported UI language is active.
      const i18nContent = t(`templates.${initialTemplate.name}.content`, { defaultValue: '' })
      htmlBody = i18nContent.trim().length > 0 ? i18nContent : null
    } else if (initialTemplate.content && initialTemplate.content.length > 0) {
      try {
        htmlBody = new TextDecoder().decode(Uint8Array.from(initialTemplate.content))
      } catch (err) {
        console.warn(
          `Failed to decode template content for "${initialTemplate.name}" (${initialTemplate.id}):`,
          err,
        )
        htmlBody = null
      }
    }

    const chain = editor.chain().focus()
    if (htmlBody) {
      chain.setContent(htmlBody).run()
    } else if (initialTemplate.description) {
      // Defensive fallback — schema-safe typed nodes (no HTML interpolation).
      chain
        .setContent({
          type: 'doc',
          content: [
            {
              type: 'heading',
              attrs: { level: 1 },
              content: [{ type: 'text', text: initialTemplate.name }],
            },
            {
              type: 'paragraph',
              content: [{ type: 'text', text: initialTemplate.description }],
            },
          ],
        })
        .run()
    }

    appliedTemplateKey.current = key
    onApplyTemplateRef.current?.(initialTemplate)
  }, [editor, initialTemplate, entryId, t])

  // Daily Chat → "Save as entry" handoff. Mirrors the template effect
  // above: apply the drafted HTML once, only on a still-empty editor,
  // guarded against HMR / StrictMode re-mounts via a key ref.
  const appliedChatDraftKey = useRef<string | null>(null)
  useEffect(() => {
    if (!editor || !initialChatDraftHtml) return
    const key = `${entryId ?? ''}::chat-draft`
    if (appliedChatDraftKey.current === key) return
    if (!editor.isEmpty) {
      appliedChatDraftKey.current = key
      return
    }
    editor.chain().focus().setContent(initialChatDraftHtml).run()
    appliedChatDraftKey.current = key
  }, [editor, initialChatDraftHtml, entryId])

  // Daily Chat → "Update the entry" append. Unlike the seed effect above, the
  // doc is ALREADY populated for an append, so we insert at the end rather
  // than `setContent`. Guarded by the nonce `id` (each enqueue mints a fresh
  // one) to dedupe StrictMode/HMR double-apply — NOT by `editor.isEmpty`,
  // because the doc being non-empty is the expected precondition here.
  const appliedAppendId = useRef<string | null>(null)
  useEffect(() => {
    if (!editor || !initialChatAppendHtml) return
    if (!editor.isEditable) return
    if (appliedAppendId.current === initialChatAppendHtml.id) return
    editor.chain().focus('end').insertContent(initialChatAppendHtml.html).run()
    appliedAppendId.current = initialChatAppendHtml.id
  }, [editor, initialChatAppendHtml])

  return (
    <MediaZoomContext.Provider
      value={{
        onZoom: handleZoom,
        onMediaRemoved: () => {
          refreshAllMedia()
          // Inline-image removal can clear `cover_media_id` via the
          // `clear_entry_cover_on_media_delete` DB trigger when the
          // removed media WAS the cover. Refetch the entry so the
          // entry-list card thumbnail updates immediately.
          onCoverMaybeChanged?.()
        },
        onImmediateSave,
      }}
    >
      <div
        className="flex h-full min-h-0 flex-1 flex-col"
        data-distraction-mode={distractionMode ? 'true' : 'false'}
      >
        {/* Unified EXIF date+location suggestion modal. Shows one tab,
            two tabs, or doesn't render — depending on which sides have
            multi-candidate suggestions that aren't already suppressed. */}
        {showMetadataModal && (
          <EntryMetadataSuggestionModal
            dates={modalDates}
            locations={modalLocations}
            onConfirm={async (payload: EntryMetadataSuggestionPayload) => {
              // Mark BOTH session flags + close immediately so the
              // suggestion useEffects don't re-open the modal on the
              // next render while DB writes are in flight. Even sides
              // the user didn't pick get the "user has finalized"
              // treatment — they explicitly engaged with the modal.
              setEntryDateUserEdited(true)
              setEntryLocationUserEdited(true)
              if (!entryId) return
              try {
                // Apply date if picked.
                if (payload.date !== undefined) {
                  await updateEntryDate(entryId, payload.date)
                }
                // Apply location if picked. The modal reverse-geocoded
                // the chosen coords; prefer the modal's freshly-fetched
                // label/address over whatever was on the entry before.
                // Fall back to existing entry label/address so we don't
                // overwrite a manually-typed name with an empty value
                // when the geocoder had no match.
                if (payload.location) {
                  const current = await getEntry(entryId, activeVaultId)
                  const label = payload.locationLabel ?? current?.location_label ?? null
                  const address = payload.locationAddress ?? current?.location_address ?? null
                  await updateEntryLocation(
                    entryId,
                    payload.location.latitude,
                    payload.location.longitude,
                    label,
                    address,
                  )
                  const weatherDate = payload.date ?? current?.entry_date ?? entry?.entry_date
                  if (weatherDate != null) {
                    await applyEntryWeather(
                      entryId,
                      payload.location.latitude,
                      payload.location.longitude,
                      weatherDate,
                    )
                  }
                }
                // Always durably suppress the date side once the user
                // has confirmed (matches the old single-modal behavior).
                // Location's durable suppression is implicit: setting
                // latitude/longitude flips `entryHasLocation` to true,
                // which the useEffect uses as a permanent guard.
                if (showDateInModal) {
                  await markEntryDateUserEdited(entryId)
                }
                // In-place patch the entry list card — no Loading flash.
                onCoverMaybeChangedRef.current?.()
              } catch (err) {
                console.error('Failed to apply EXIF metadata suggestion:', err)
              }
            }}
            onClose={() => {
              setEntryDateUserEdited(true)
              setEntryLocationUserEdited(true)
              // Cancel = "I've seen this, don't show again" for BOTH
              // sides. Durably suppress the date side (location's
              // durable suppression requires actually setting coords,
              // which Cancel doesn't do — session flag is the best
              // we can offer without polluting the DB on a no-op).
              if (entryId && showDateInModal) {
                void markEntryDateUserEdited(entryId).then(() => {
                  onCoverMaybeChangedRef.current?.()
                })
              }
            }}
          />
        )}
        {editable && editor && entry && (
          <EditorHeader
            entry={entry}
            onEmotionPickerOpen={onEmotionPickerOpen ?? (() => {})}
            onRefetchWeather={onRefetchWeather ?? (() => {})}
            onEntryRefetch={() => onCoverMaybeChangedRef.current?.()}
          />
        )}
        {editable && editor && (
          <EditorBubbleMenu
            editor={editor}
            onRewriteSelection={onRewriteSelection}
            rewriteDisabledReason={proseVoiceDisabledReason}
          />
        )}
        {editable && editor && (
          <ImageBubbleMenu editor={editor} scrollTarget={editorScrollTarget ?? undefined} />
        )}
        {editable && editor && (
          <VideoBubbleMenu editor={editor} scrollTarget={editorScrollTarget ?? undefined} />
        )}
        {titleSlot && fixedTitleEnabled ? (
          <div className="bg-panel-3 shrink-0">
            <div className={editorContentColumnClass(distractionMode, 'px-6 pt-6')}>
              {titleSlot}
            </div>
          </div>
        ) : null}
        <div
          ref={(el) => {
            editorScrollRestoreRef.current = el
            setEditorScrollTarget(el)
          }}
          data-testid="editor-canvas"
          data-editor-scroll-container
          className="min-h-0 flex-1 overflow-y-auto [&_.ProseMirror]:min-h-full [&_.ProseMirror]:outline-none"
          onClick={(e) => {
            if (!editor || !editable) return
            const target = e.target as HTMLElement
            if (target.closest('.ProseMirror')) return
            if (target.closest('input, textarea, [contenteditable]')) return
            editor.commands.focus('end')
          }}
        >
          <div
            className={editorContentColumnClass(
              distractionMode,
              cn('px-6 pb-10', fixedTitleEnabled ? 'pt-4' : 'pt-6'),
            )}
          >
            {titleSlot && !fixedTitleEnabled ? titleSlot : null}
            {editor && (
              <div
                className={editorContentWrapperClass({
                  justify: justifyEnabled,
                  ...typography,
                })}
                dir={rightToLeftEnabled ? 'rtl' : 'ltr'}
              >
                <EditorContent editor={editor} />
              </div>
            )}
          </div>
        </div>
        {editable && (
          <AttachmentStrip
            attachments={attachments.attachments}
            collapsed={isMediaStripCollapsed}
            onCollapsedChange={handleMediaStripCollapsedChange}
            onRemoveRequest={(mediaId) => setConfirmRemoveMediaId(mediaId)}
            onZoomRequest={handleZoom}
            onPlayAudioRequest={(mediaId) => setPlayingAudioId(mediaId)}
            onViewFileRequest={(mediaId) => setViewingFileId(mediaId)}
            onDownloadFileRequest={(mediaId) => {
              const row = attachments.attachments.find((r) => r.id === mediaId)
              if (row) void downloadAttachment(row)
            }}
          />
        )}
        {editable && editor && entry && (
          <EntryLocationRow entry={entry} onLocationSelect={onLocationSelect ?? (() => {})} />
        )}
        {playingAudioId && (
          <AudioPlaybackModal mediaId={playingAudioId} onClose={() => setPlayingAudioId(null)} />
        )}
        {viewingFileId &&
          (() => {
            const row = attachments.attachments.find((r) => r.id === viewingFileId)
            return row ? (
              <FileViewerModal media={row} onClose={() => setViewingFileId(null)} />
            ) : null
          })()}
        {/* Paste mode-picker popover — anchors to caret position */}
        <ImageModePopover
          open={!!pastePopoverAnchor}
          anchorRect={pastePopoverAnchor}
          onSelect={(mode) => void handlePasteModeSelect(mode)}
          onClose={() => void handlePasteDismiss()}
        />
        {/* Attachment strip remove confirmation */}
        {confirmRemoveMediaId && (
          <ConfirmDialog
            open={true}
            title={t('confirm_remove_attachment.title')}
            description={t('confirm_remove_attachment.description')}
            confirmLabel={t('confirm_remove_attachment.confirm')}
            onConfirm={() => {
              let wasInline = false
              if (editor) {
                editor.state.doc.descendants((node) => {
                  if (node.attrs?.['data-media-id'] === confirmRemoveMediaId) {
                    wasInline = true
                    return false
                  }
                  return true
                })
                removeMediaNodesById(editor, confirmRemoveMediaId)
              }
              if (wasInline) {
                // Tracker observes the disappearance; bytes delete after save.
                onImmediateSave?.()
              } else {
                // Attached-only (never in the doc) is not tracked — delete now.
                void deleteMedia(confirmRemoveMediaId).then(() => {
                  attachments.refetch()
                  refreshAllMedia()
                  onCoverMaybeChanged?.()
                })
              }
              setConfirmRemoveMediaId(null)
            }}
            onClose={() => setConfirmRemoveMediaId(null)}
          />
        )}
        {/* Media carousel — portaled into the layout card so the overlay
            covers the app's main body (everything except titlebar, sidebar and
            footer) instead of the editor column alone. Falls back to
            document.body if the host is missing (e.g. isolated mounts). */}
        {lightboxIndex !== null &&
          createPortal(
            <MediaGalleryCarousel
              media={carouselItems}
              initialIndex={lightboxIndex}
              onClose={() => setLightboxIndex(null)}
            />,
            document.getElementById(BODY_OVERLAY_HOST_ID) ?? document.body,
          )}
        {mathEdit && (
          <MathEditModal
            title={
              mathEdit.mode === 'insert-block' || mathEdit.mode === 'edit-block'
                ? t('math.block_title')
                : t('math.inline_title')
            }
            initialLatex={mathEdit.latex}
            onConfirm={handleMathConfirm}
            onClose={() => setMathEdit(null)}
          />
        )}
        {editable && editor && entry && (
          <EditorFooter
            entry={entry}
            journal={journal ?? null}
            editor={editor}
            mathEnabled={mathEnabled && mathExtensions.length > 0}
            onInsertInlineMath={() => setMathEdit({ mode: 'insert-inline', latex: '' })}
            onInsertBlockMath={() => setMathEdit({ mode: 'insert-block', latex: '' })}
            onToggleFavorite={onToggleFavorite ?? (() => {})}
            highlightsEnabled={highlightsEnabled}
            goDeeperEnabled={goDeeperEnabled}
            wordCount={wordCount}
            renderHighlightsPopover={renderHighlightsPopover}
            renderGoDeeperPopover={renderGoDeeperPopover}
            continueWritingDisabledReason={proseVoiceDisabledReason}
            onContinueWriting={
              onContinueWriting
                ? async () => {
                    // Same revision guard as rewrite: append only into the
                    // document that supplied the context. Yjs / local edits
                    // during the await make end-of-doc insertion unsafe.
                    const requestDoc = editor.state.doc
                    const continuation = await onContinueWriting(editor.getText())
                    if (requestDoc !== editor.state.doc) {
                      toast(
                        t('bubble.continue_changed', {
                          defaultValue: 'Entry changed. Please try again.',
                        }),
                      )
                      return
                    }
                    editor.view.dispatch(
                      editor.state.tr.insertText(continuation, editor.state.doc.content.size),
                    )
                  }
                : undefined
            }
            onGeneratedImage={
              onGeneratedImage
                ? (result) => {
                    onGeneratedImage(result)
                    // Attached rows never land in the ProseMirror doc, so the
                    // media-id watcher below won't fire — refetch the strip
                    // (and lightbox list) explicitly. Inline path still gets
                    // strip refresh from that watcher after insertContent.
                    if (result.insertionMode === 'attached') {
                      attachments.refetch()
                      refreshAllMedia()
                    }
                  }
                : undefined
            }
            onAttachmentAdded={async () => {
              attachments.refetch()
              refreshAllMedia()
              onCoverMaybeChanged?.()
              // Date + location suggestions both fire after media is added
              // via the Aa menu — same contract as the paste handler. Run
              // them in parallel so the spinner overlay waits only as long
              // as the slower of the two queries.
              await Promise.all([triggerCheckRef.current(), triggerLocationCheckRef.current()])
            }}
            onInlineImageInserted={async () => {
              onCoverMaybeChanged?.()
              await Promise.all([triggerCheckRef.current(), triggerLocationCheckRef.current()])
            }}
            onApplyTemplate={
              onApplyTemplate
                ? (template) => {
                    let htmlBody: string | null = null
                    if (template.is_predefined) {
                      const i18nContent = t(`templates.${template.name}.content`, {
                        defaultValue: '',
                      })
                      htmlBody = i18nContent.trim().length > 0 ? i18nContent : null
                    } else if (template.content && template.content.length > 0) {
                      try {
                        htmlBody = new TextDecoder().decode(Uint8Array.from(template.content))
                      } catch (err) {
                        console.warn(
                          `Failed to decode template content for "${template.name}" (${template.id}):`,
                          err,
                        )
                        htmlBody = null
                      }
                    }
                    const chain = editor.chain().focus()
                    if (htmlBody) {
                      if (editor.isEmpty) {
                        chain.setContent(htmlBody).run()
                      } else {
                        chain.insertContent(htmlBody).run()
                      }
                    } else {
                      const nodes: Array<Record<string, unknown>> = [
                        {
                          type: 'heading',
                          attrs: { level: 1 },
                          content: [{ type: 'text', text: template.name }],
                        },
                      ]
                      if (template.description) {
                        nodes.push({
                          type: 'paragraph',
                          content: [{ type: 'text', text: template.description }],
                        })
                      }
                      if (editor.isEmpty) {
                        chain.setContent({ type: 'doc', content: nodes }).run()
                      } else {
                        chain.insertContent(nodes).run()
                      }
                    }
                    onApplyTemplate(template)
                  }
                : undefined
            }
          />
        )}
      </div>
    </MediaZoomContext.Provider>
  )
}
