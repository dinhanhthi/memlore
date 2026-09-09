import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatTime } from '../../lib/dates'
import { Star, Trash2, Video, Image as ImageIcon, LockKeyhole } from 'lucide-react'
import type { Entry } from '../../types/entry'
import type { Journal, Tag } from '../../types/journal'
import { cn } from '../../lib/cn'
import { EMOTION_BY_KEY } from '../common/emotions'
import { ensureVideoThumbnail, getEntry, getMediaStatus, listMediaForEntry } from '../../lib/tauri'
import { emitEntryPatched } from '../../hooks/useEntries'
import { ensureMediaCached, peekCachedMedia, resolveCachedMedia } from '../media/mediaCache'
import { useTabStore } from '../../stores/tabStore'
import { useEntryStore } from '../../stores/entryStore'
import { useInvisibleLockStore } from '../../stores/invisibleLockStore'
import { useSecondLockStore } from '../../stores/secondLockStore'
import {
  resolveLockFilterVisibility,
  shouldShowInvisibleLockEntrySignals,
  shouldShowSecondLockEntrySignals,
} from '../../lib/entryFilterSort'
import { isMiddleClick, isNewTabModifier } from '../../lib/modifierClick'
import { useTitleStreamStore } from '../../stores/titleStreamStore'
import { useEntryLocationPendingStore } from '../../stores/entryLocationPendingStore'
import { useUiStore } from '../../stores/uiStore'
import { Modal } from '../common/Modal'
import { Tooltip } from '../common/Tooltip'
import { AiIcon } from '../common/AiIcon'
import { Button } from '../common/Button'
import { EntryContextMenu } from './EntryContextMenu'
import { AddAndApplyLocationModal } from './AddAndApplyLocationModal'
import { EntrySummaryModal } from './EntrySummaryModal'
import { GenerateImageDialog } from '../editor/GenerateImageButton'
import { VersionHistoryModal } from './VersionHistoryModal'
import { SecondLockPromptModal } from '../common/SecondLockPromptModal'
import { SecondLockIntroModal } from '../common/SecondLockIntroModal'
import { EntryCoverBackdrop } from './EntryCoverBackdrop'
import { EntryTagStrip } from './EntryTagStrip'

interface EntryCardProps {
  entry: Entry
  isSelected: boolean
  onClick: () => void
  journal?: Journal | null
  tags?: readonly Tag[]
  idleBg: string
  onDelete?: () => void
  onToggleFavorite?: () => void
}

function EntryCardImpl({
  entry,
  isSelected,
  onClick,
  journal,
  tags,
  idleBg,
  onDelete,
  onToggleFavorite,
}: EntryCardProps) {
  const { t, i18n } = useTranslation('editor')
  const timeFormat = useUiStore((s) => s.timeFormat)
  const activeVaultId = useInvisibleLockStore((s) => s.activeVaultId)
  const secondLockEnabled = useSecondLockStore((s) => s.isEnabled)
  const secondLockSessionUnlocked = useSecondLockStore((s) => s.isSessionUnlocked)
  const showExistence = useSecondLockStore((s) => s.showExistence)
  const invisibleSessionUnlocked = useInvisibleLockStore((s) => s.activeVaultId != null)
  const lockFilterVisibility = resolveLockFilterVisibility({
    secondLockEnabled,
    secondLockSessionUnlocked,
    showExistence,
    invisibleSessionUnlocked,
  })
  const showSecondLockSignals =
    entry.is_locked && shouldShowSecondLockEntrySignals(lockFilterVisibility)
  const showInvisibleLockSignals =
    entry.is_invisible && shouldShowInvisibleLockEntrySignals(lockFilterVisibility)
  const showLockFrame = showSecondLockSignals || showInvisibleLockSignals
  const timeLabel = formatTime(entry.entry_date, i18n.language, timeFormat === '12h')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [secondLockPromptOpen, setSecondLockPromptOpen] = useState(false)
  const [secondLockIntroOpen, setSecondLockIntroOpen] = useState(false)
  const isCoveredLocked =
    entry.is_locked &&
    entry.title === null &&
    entry.preview_text === null &&
    entry.content_text === null

  // Synchronously seed cover from the module-level cache on first render so
  // cache hits paint without a skeleton flash (no IPC, no async tick).
  type CoverState = { src: string } | { videoOnly: true } | null
  const initialCoverRef = useRef<{ coverMediaId: string | null; state: CoverState } | null>(null)
  if (!initialCoverRef.current || initialCoverRef.current.coverMediaId !== entry.cover_media_id) {
    const cached = entry.cover_media_id ? peekCachedMedia(entry.cover_media_id, true) : null
    initialCoverRef.current = {
      coverMediaId: entry.cover_media_id ?? null,
      state: cached ? { src: cached.blobUrl } : null,
    }
  }
  const [cover, setCover] = useState<CoverState>(initialCoverRef.current.state)

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [showSummary, setShowSummary] = useState(false)
  const [showGenerateImage, setShowGenerateImage] = useState(false)
  const [showVersionHistory, setShowVersionHistory] = useState(false)
  const [addLocationOpen, setAddLocationOpen] = useState(false)
  // Per-card selector so unrelated cards bail out on `Object.is` and don't
  // re-render on every streamed token. Returns the active stream state
  // ONLY when it targets this card's entry; null otherwise. Reference is
  // stable across unrelated updates (always the same `null`), so 30 cards
  // × 50 tokens no longer means 1500 wasted renders.
  const titleStream = useTitleStreamStore((s) => {
    const st = s.state
    if (st.kind === 'idle') return null
    return st.entryId === entry.id ? st : null
  })
  const isThisEntryStreaming =
    titleStream !== null && (titleStream.kind === 'streaming' || titleStream.kind === 'done')
  const locationPending = useEntryLocationPendingStore((s) => s.pendingIds.has(entry.id))

  // Refresh this card after a context-menu image generation. Mirrors
  // `EditorPanel.handleCoverMaybeChanged`: patch the row in place rather than
  // emitting `memlore:entries-changed`, which would flash the whole list back
  // to its loading placeholder. `generateInlineImage` already fires
  // `emitMediaChanged()`, so only the cover/media_count need propagating here.
  async function refreshCoverAfterGeneratedImage() {
    try {
      const updated = await getEntry(entry.id, activeVaultId)
      if (!updated) return
      useEntryStore.getState().updateEntry(updated)
      emitEntryPatched(entry.id, {
        cover_media_id: updated.cover_media_id,
        media_count: updated.media_count,
      })
    } catch {
      // Best-effort — the card just stays stale until the next list reload.
    }
  }

  // Cover resolution:
  //   - If `cover_media_id` is an image → use the module-level media cache
  //     (peekCachedMedia / resolveCachedMedia) so tab switches never re-fetch.
  //   - If it's a video → prefer the extracted poster JPEG. When the row
  //     lacks `thumbnail_path` (legacy insert, or extraction failed), call
  //     `ensure_video_thumbnail` to backfill on-demand, then re-pull the
  //     status. mediaCache.ts pins the Blob MIME to `image/jpeg` for
  //     `useThumbnail` reads so the `<img>` below decodes correctly.
  //   - If even the backfill yielded nothing → look for the first image in
  //     the entry's media list and resolve that instead.
  //   - If neither is available → fall back to the generic video icon.
  const coverMediaId = entry.cover_media_id
  const entryId = entry.id
  useEffect(() => {
    if (!coverMediaId) {
      setCover(null)
      return
    }

    // Fast path: thumbnail already in the module cache — set state
    // synchronously (covers both first mount and transitions to a
    // different `coverMediaId` whose bytes are already cached) and skip
    // all async work entirely.
    const cached = peekCachedMedia(coverMediaId, true)
    if (cached) {
      setCover({ src: cached.blobUrl })
      return
    }

    let cancelled = false

    // Resolve the cover from cache. Returns true if a blob URL was set
    // (cache hit OR backend already has the bytes). Returns false on
    // cloud-only / not-yet-downloaded.
    const tryHydrate = async (mediaId: string): Promise<boolean> => {
      const entry = await resolveCachedMedia(mediaId, true)
      if (cancelled) return true // treat cancel as "done" to stop further work
      if (entry) {
        setCover({ src: entry.blobUrl })
        return true
      }
      return false
    }

    const resolveImage = async (mediaId: string) => {
      // First attempt: maybe the bytes are already local.
      if (await tryHydrate(mediaId)) return

      // Bytes not on disk yet. Kick off backend download (idempotent +
      // deduped + retry-friendly — see ensureMediaCached). The promise
      // resolves to a boolean; on `true` we re-hydrate. On `false` (and
      // even after cancel), the `media-changed` listener below catches
      // any other concurrent success and re-tries on next event.
      const ok = await ensureMediaCached(mediaId, true)
      if (cancelled) return
      if (ok) {
        await tryHydrate(mediaId)
      }
    }

    const loadCover = async () => {
      try {
        let status = await getMediaStatus(coverMediaId)
        if (cancelled) return
        if (!status.fileType.startsWith('video/')) {
          await resolveImage(coverMediaId)
          return
        }
        // Cover is a video. Preferred path: AVFoundation extracted a
        // poster JPEG at insert time and `status.thumbnailPath` is set —
        // resolveImage hits `read_media_thumbnail_bytes`, which returns
        // the JPEG bytes. mediaCache.ts pins the Blob MIME to
        // `image/jpeg` for `useThumbnail` reads, so the `<img>` below
        // decodes correctly.
        if (!status.thumbnailPath) {
          // Legacy video row inserted before the extractor existed, or
          // extraction failed at insert time. Trigger on-demand backfill
          // via the `ensure_video_thumbnail` Tauri command — it's idempotent
          // and best-effort (returns false when the bridge can't decode
          // the codec). On success, re-pull the status so the new
          // `thumbnailPath` flows into the renderer.
          try {
            const generated = await ensureVideoThumbnail(coverMediaId)
            if (cancelled) return
            if (generated) {
              status = await getMediaStatus(coverMediaId)
              if (cancelled) return
            }
          } catch {
            // Best-effort: silent fail, fall through to the image fallback
            // / `{videoOnly: true}` placeholder below.
          }
        }
        if (status.thumbnailPath) {
          if (await tryHydrate(coverMediaId)) return
          // Bytes not on disk yet (cloud-only). Kick off ensure +
          // re-hydrate, same recipe as the image path.
          await resolveImage(coverMediaId)
          return
        }
        // No poster available even after the backfill attempt. Fall back
        // to the first image in this entry, then the generic video icon
        // if even that's absent.
        const rows = await listMediaForEntry(entryId, undefined, activeVaultId)
        if (cancelled) return
        const firstImage = rows.find((r) => r.file_type.startsWith('image/'))
        if (firstImage) {
          await resolveImage(firstImage.id)
        } else {
          setCover({ videoOnly: true })
        }
      } catch {
        // Transient failure: leave cover null. The media-changed listener
        // below auto-retries when another caller succeeds (e.g. user opens
        // the entry and downloads the full image, which emits the event).
      }
    }

    // Auto-download trigger fires immediately on mount — no idle defer
    // for the trigger itself. The IPC dedupe in mediaCache + ensure-
    // Media-Cached handles concurrent mount storms (200 cards mounting
    // the same image only fire one IPC + one Drive request).
    void loadCover()

    // Listen for media-cached events emitted by ensureMediaCached when
    // a Drive download finishes anywhere in the app. On every event,
    // peek the cache — if a blob is now available, hydrate. This is
    // what unstucks the "cover stuck null" case where the card mounted
    // before the backend finished writing the thumbnail to disk.
    const onMediaCached = () => {
      if (cancelled) return
      const hit = peekCachedMedia(coverMediaId, true)
      if (hit) {
        setCover({ src: hit.blobUrl })
        return
      }
      // No cache hit yet — opportunistically re-attempt the full flow.
      // Cheap because resolveCachedMedia hits the dedupe map if another
      // caller is already in flight.
      void resolveImage(coverMediaId)
    }
    window.addEventListener('memlore:media-cached', onMediaCached)

    return () => {
      cancelled = true
      window.removeEventListener('memlore:media-cached', onMediaCached)
      // Do NOT revoke blob URLs here — they live in the module-level LRU
      // cache (mediaCache.ts) and must outlive the component so tab
      // switches don't cause re-fetches. The cache handles eviction via
      // LRU and invalidateMediaCache() is called on media deletion.
    }
  }, [coverMediaId, entryId, activeVaultId])

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    setConfirmOpen(true)
  }

  const handleFavoriteClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    onToggleFavorite?.()
  }

  const handleConfirmDelete = () => {
    setConfirmOpen(false)
    onDelete?.()
  }

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    if (isCoveredLocked) return
    setContextMenu({ x: e.clientX, y: e.clientY })
  }

  // The card's displayed title: streaming partial > finalised title >
  // saved title. When the entry has no title and no in-flight title
  // stream, the title row is hidden entirely — no "Untitled"
  // placeholder. Showing the partial in place of the title gives
  // realtime feedback when the user kicks off "Generate title" from
  // the context menu on an entry that isn't open in the editor.
  const hasRealTitle = entry.title != null && entry.title.trim().length > 0
  const showTitleRow = hasRealTitle || isThisEntryStreaming
  const titleIsPlaceholder = titleStream?.kind === 'streaming' && titleStream.partial.length === 0
  let displayTitle: string = entry.title ?? ''
  if (titleStream?.kind === 'streaming') {
    displayTitle =
      titleStream.partial || t('entry_card.generating_title', { defaultValue: 'Generating title…' })
  } else if (titleStream?.kind === 'done') {
    displayTitle = titleStream.title
  }

  const openEntryInNewTab = () => {
    // Seed entriesById so the background tab's title resolves immediately.
    // useEntries does not populate entriesById — only EditorPanel does on mount.
    // Without this, the new tab's title falls back to "Entries" until the user
    // switches to it and the editor mounts.
    useEntryStore.getState().mergeEntries([entry])
    useTabStore.getState().newTab(
      {
        activeView: 'entries',
        journalId: entry.journal_id,
        selectedEntryId: entry.id,
        selectedCalendarDate: null,
        selectedTagId: null,
      },
      { background: true },
    )
  }

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={(e) => {
          if (isCoveredLocked) {
            e.preventDefault()
            setSecondLockPromptOpen(true)
            return
          }
          if (isNewTabModifier(e)) {
            e.preventDefault()
            openEntryInNewTab()
            return
          }
          onClick()
        }}
        onMouseDown={(e) => {
          if (isMiddleClick(e)) e.preventDefault()
        }}
        onAuxClick={(e) => {
          if (isMiddleClick(e)) {
            e.preventDefault()
            openEntryInNewTab()
          }
        }}
        onContextMenu={handleContextMenu}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            if (isCoveredLocked) {
              setSecondLockPromptOpen(true)
              return
            }
            onClick()
          }
        }}
        className={cn(
          'group border-border-default relative w-full shrink-0 cursor-pointer overflow-hidden border-b px-4 py-3 text-left last:border-b-0',
          'transition-[background-color,box-shadow,--entry-card-fill] duration-(--motion-duration-fast) ease-(--motion-ease-out-expo) motion-reduce:transition-none',
          // Lock frames own the left edge. A container `border-l` (even
          // transparent) sits outside the stripe and reads as a white gap.
          showLockFrame
            ? 'border-l-0'
            : isSelected
              ? 'border-l-accent border-l-2'
              : 'border-l-2 border-l-transparent',
          'bg-(--entry-card-fill)',
          isSelected
            ? '[--entry-card-fill:var(--color-elevated)]'
            : '[--entry-card-fill:var(--entry-card-idle-bg)]',
          'hover:[--entry-card-fill:var(--entry-card-hover-bg)]',
        )}
      >
        {/* Lock marker — a left-edge stripe that replaces the old header lock
            icons. Second-locked = a double line; invisible = a dashed line. When
            the entry is selected the stripe turns accent-colored and stands in
            for the usual selection bar (omitted on the container for locked
            entries), so selection is still shown exactly once.
            The double line is painted with a gradient rather than
            `border-double`: the native style fixes the gap at 1/3 of the width
            (and WebKit collapses it to one solid line at small sizes), whereas
            the gradient lets us set the line width and gap independently and
            renders identically in WebKit and Chromium. Color comes from
            `currentColor`, so one text-* class drives both the gradient and the
            dashed border. Wrapped in a Tooltip (widened to `w-3` for an easy
            hover target) so hovering explains what it means; clicks bubble to
            the card, so selecting still works. */}
        {showLockFrame && (
          <Tooltip
            content={
              showSecondLockSignals
                ? t('entry_card.second_lock_aria')
                : t('entry_card.invisible_lock_aria')
            }
            placement="right"
            className={cn(
              'absolute inset-y-0 left-0 z-20 w-3',
              isSelected ? 'text-accent' : 'text-fg-muted/70',
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'block h-full w-full',
                !showSecondLockSignals && 'border-l-2 border-dashed border-current',
              )}
              style={
                showSecondLockSignals
                  ? {
                      // Two 1px lines with a 2px gap — tweak the px stops to
                      // widen/narrow the gap or the lines independently.
                      backgroundImage:
                        'linear-gradient(to right, currentColor 0, currentColor 1px, transparent 1px, transparent 3px, currentColor 3px, currentColor 4px, transparent 4px)',
                      backgroundRepeat: 'no-repeat',
                    }
                  : undefined
              }
            />
          </Tooltip>
        )}

        {/* Top row: time · journal · lock state · actions · mood */}
        <div className="relative z-10 mb-2.5 flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="text-fg-faint text-2xs shrink-0 font-mono tracking-[0.2px]">
              {timeLabel}
            </span>
            {journal && (
              <Tooltip
                content={t('entry_card.journal_aria', { name: journal.name })}
                className="min-w-0"
              >
                <span
                  role="img"
                  aria-label={t('entry_card.journal_aria', { name: journal.name })}
                  className="text-fg-muted text-2xs flex min-w-0 items-center gap-1.5"
                >
                  <span
                    aria-hidden="true"
                    className="size-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: journal.color ?? 'var(--color-accent)' }}
                  />
                  <span className="truncate">{journal.name}</span>
                </span>
              </Tooltip>
            )}
            {/* Lock state is conveyed visually by the card's border frame
                (see below). Keep an sr-only label so the affordance the icon
                used to carry is still announced to assistive tech. */}
            {showSecondLockSignals && (
              <span className="sr-only">
                {t('entry_card.second_lock_aria', { defaultValue: 'Second-locked entry' })}
              </span>
            )}
            {showInvisibleLockSignals && (
              <span className="sr-only">
                {t('entry_card.invisible_lock_aria', { defaultValue: 'Invisible-locked entry' })}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {!isCoveredLocked && onDelete && (
              <button
                type="button"
                aria-label={t('entry_card.delete_aria')}
                onClick={handleDeleteClick}
                className={cn(
                  'shrink-0 rounded-md p-1 transition-opacity duration-150',
                  // opacity reveal (not a ring): keyboard focus must un-hide the button,
                  // or Tab lands on an invisible-but-clickable delete control.
                  'text-fg-muted opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100',
                  'hover:text-danger',
                )}
              >
                <Trash2 className="size-3.5" strokeWidth={1.75} />
              </button>
            )}
            {!isCoveredLocked && onToggleFavorite && (
              <button
                type="button"
                aria-label={t('entry_card.favorite_aria')}
                onClick={handleFavoriteClick}
                className={cn(
                  'shrink-0 rounded-md p-1 transition-opacity duration-150',
                  entry.is_favorite
                    ? 'text-warning'
                    : 'text-fg-muted hover:text-accent opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100',
                )}
              >
                <Star
                  className="size-3.5"
                  strokeWidth={1.75}
                  fill={entry.is_favorite ? 'currentColor' : 'none'}
                />
              </button>
            )}
            {!isCoveredLocked && entry.emotion && (
              <Tooltip content={t('entry_card.mood_aria', { mood: entry.emotion })}>
                <span
                  role="img"
                  aria-label={t('entry_card.mood_aria', { mood: entry.emotion })}
                  className="ml-1 size-2.5 rounded-full bg-(--entry-emotion-color) dark:bg-(--entry-emotion-color-dark)"
                  style={
                    {
                      '--entry-emotion-color': EMOTION_BY_KEY[entry.emotion].hue,
                      '--entry-emotion-color-dark': EMOTION_BY_KEY[entry.emotion].hueDark,
                    } as React.CSSProperties
                  }
                />
              </Tooltip>
            )}
          </div>
        </div>

        {isCoveredLocked ? (
          <div className="text-fg-muted flex items-center gap-2 py-2">
            <LockKeyhole className="size-4 shrink-0" strokeWidth={1.75} />
            <span className="text-sm font-medium">{t('entry_card.locked_entry')}</span>
          </div>
        ) : (
          /* Title + preview on the left, cover on the right when present. */
          <div className="flex items-start gap-3">
            <div
              className={cn(
                'relative z-10 min-w-0 flex-1',
                cover && 'src' in cover && 'max-w-[64%]',
              )}
            >
              {/* Title — Nunito 700, 2-line clamp. While the AI is
                streaming a suggested title for this entry, swap the
                title for the partial text + a spinner-ish sparkle.
                Hidden entirely when the entry has no title and no
                in-flight stream — no "Untitled" placeholder. */}
              {showTitleRow && (
                <div
                  className={cn(
                    'font-title line-clamp-2 text-base leading-tight font-semibold tracking-[-0.3px]',
                    titleIsPlaceholder ? 'text-fg-muted italic' : 'text-fg',
                    isThisEntryStreaming && 'flex items-center gap-1.5',
                  )}
                >
                  {titleStream?.kind === 'streaming' && <AiIcon className="shrink-0" aria-hidden />}
                  <span>{displayTitle}</span>
                </div>
              )}

              {/* Preview excerpt — skip top margin when the title row
                  is hidden so it does not stack with the header gap. */}
              {entry.preview_text && (
                <p
                  className={cn(
                    'text-fg-secondary text- line-clamp-2 leading-[1.45]',
                    showTitleRow && 'mt-2.5',
                  )}
                >
                  {entry.preview_text}
                </p>
              )}
            </div>

            {coverMediaId && cover && 'src' in cover ? (
              <EntryCoverBackdrop src={cover.src} isSelected={isSelected} idleBg={idleBg} />
            ) : coverMediaId ? (
              <div className="relative size-16 shrink-0">
                {!cover && (
                  <div
                    data-testid="entry-card-cover-skeleton"
                    aria-hidden="true"
                    className="border-border-default bg-border-default/70 text-fg-muted/50 flex size-16 items-center justify-center rounded-lg border motion-safe:animate-pulse"
                  >
                    <ImageIcon className="size-6" strokeWidth={1.5} />
                  </div>
                )}
                {cover && 'videoOnly' in cover && (
                  <div
                    data-testid="entry-card-cover-video"
                    aria-label={t('entry_card.video_cover_aria', {
                      defaultValue: 'Video attachment',
                    })}
                    className="border-border-default bg-accent-soft text-accent-text flex size-16 items-center justify-center rounded-lg border"
                  >
                    <Video className="size-6" strokeWidth={1.75} />
                  </div>
                )}
              </div>
            ) : null}
          </div>
        )}

        {!isCoveredLocked && (
          <div className="relative z-10">
            <EntryTagStrip
              tags={tags ?? []}
              location={entry.location_label}
              weatherIcon={entry.weather_icon}
              weatherSummary={entry.weather_summary}
              locationLoading={locationPending}
            />
          </div>
        )}
      </div>

      {confirmOpen && (
        <Modal onClose={() => setConfirmOpen(false)} maxWidth={360}>
          <Modal.Header description={t('entry_card.delete_description')}>
            {t('entry_card.delete_title')}
          </Modal.Header>
          <Modal.Footer>
            <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(false)}>
              {t('entry_card.delete_cancel')}
            </Button>
            <Button variant="destructive" size="sm" onClick={handleConfirmDelete}>
              {t('entry_card.delete_confirm')}
            </Button>
          </Modal.Footer>
        </Modal>
      )}

      {contextMenu && (
        <EntryContextMenu
          entryId={entry.id}
          entryDate={entry.entry_date}
          entryJournalId={entry.journal_id}
          entryEmotion={entry.emotion}
          entryHasLocation={entry.latitude !== null && entry.longitude !== null}
          entryLocked={entry.is_locked}
          entryInvisible={entry.is_invisible}
          anchor={contextMenu}
          onClose={() => setContextMenu(null)}
          onDelete={onDelete ? () => setConfirmOpen(true) : undefined}
          onSummarize={() => setShowSummary(true)}
          onGenerateImage={() => setShowGenerateImage(true)}
          onVersionHistory={() => setShowVersionHistory(true)}
          onOpenInNewTab={openEntryInNewTab}
          onSecondLockIntro={() => setSecondLockIntroOpen(true)}
          onAddLocation={() => setAddLocationOpen(true)}
        />
      )}

      {showSummary && (
        <EntrySummaryModal entryId={entry.id} onClose={() => setShowSummary(false)} />
      )}
      {showGenerateImage && (
        <GenerateImageDialog
          entryId={entry.id}
          initialPrompt=""
          // No TipTap editor behind a card — force the attach path so a
          // generated image can never end up saved with nowhere to insert it.
          allowInline={false}
          // Locked entries must never egress to an AI provider, so "From this
          // entry" is only offered when the body is safe to send. Without the
          // getter the dialog degrades to custom-prompt-only.
          getEntryText={entry.is_locked ? undefined : () => entry.content_text ?? ''}
          onInserted={() => {
            setShowGenerateImage(false)
            void refreshCoverAfterGeneratedImage()
          }}
          onCancel={() => setShowGenerateImage(false)}
        />
      )}
      {showVersionHistory && (
        <VersionHistoryModal
          entryId={entry.id}
          entryTitle={entry.title}
          onClose={() => setShowVersionHistory(false)}
        />
      )}
      {addLocationOpen && (
        <AddAndApplyLocationModal
          entryId={entry.id}
          entryDate={entry.entry_date}
          onClose={() => setAddLocationOpen(false)}
        />
      )}
      <SecondLockPromptModal
        open={secondLockPromptOpen}
        onClose={() => setSecondLockPromptOpen(false)}
        title={t('entry_card.unlock_second_lock_title', {
          defaultValue: 'Enter second-lock password',
        })}
        mode="unlock-session"
        onVerified={() => {
          setSecondLockPromptOpen(false)
          // Resume the open path that was gated while locked (session already unlocked).
          onClick()
        }}
      />
      <SecondLockIntroModal
        open={secondLockIntroOpen}
        onClose={() => setSecondLockIntroOpen(false)}
      />
    </>
  )
}

// Memo'd to keep 20+ cards in a list from re-rendering on every parent
// commit (sidebar nav, scroll, unrelated entry mutations). EntryList passes
// inline arrow callbacks (onClick / onDelete / onToggleFavorite) that have
// a fresh identity every render, so a default shallow-equal compare would
// be a no-op. Custom equality skips the callbacks and compares only the
// data props that actually change the rendered output. This is safe because
// the callbacks close over `entry.id` and the parent's stable hook actions
// (deleteEntry, toggleFavorite) — their behavior is correct on each call,
// even when the prop reference changes.
export const EntryCard = React.memo(EntryCardImpl, (prev, next) => {
  return (
    prev.entry === next.entry &&
    prev.journal === next.journal &&
    prev.tags === next.tags &&
    prev.idleBg === next.idleBg &&
    prev.isSelected === next.isSelected
  )
})
