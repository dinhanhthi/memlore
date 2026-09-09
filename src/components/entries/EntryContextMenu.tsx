import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FloatingPortal } from '@floating-ui/react'
import {
  Calendar,
  FileText,
  Tag,
  Trash2,
  FolderInput,
  Smile,
  MapPin,
  Check,
  ChevronRight,
  ExternalLink,
  Lock,
  LockKeyhole,
  EyeOff,
  History,
  SquarePen,
  MessageSquare,
  Palette,
  Plus,
} from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { MiniDatePicker } from '../common/MiniDatePicker'
import { TagPickerPopover } from '../common/TagPickerPopover'
import { AiIcon } from '../common/AiIcon'
import { EMOTIONS } from '../common/emotions'
import type { EmotionKey } from '../../types/entry'
import type { LocationAlias } from '../../types/location'
import {
  updateEntryDate,
  markEntryDateUserEdited,
  moveEntryToJournal,
  updateEntryEmotion,
  updateEntryLocation,
  listLocationAliases,
} from '../../lib/tauri'
import { LOCATION_SUBMENU_PANE_CLASS } from '../../lib/entryContextLocationSubmenu'
import { applyLocationAliasToEntry } from '../../hooks/applyLocationAliasToEntry'
import { emitEntriesChanged } from '../../hooks/useEntries'
import { useTitleStream } from '../../hooks/useTitleStreamController'
import { useAiTitleSuggestionsEnabled } from '../../hooks/useAiTitleSuggestionsEnabled'
import { useAiMultiEntrySummaryEnabled } from '../../hooks/useAiMultiEntrySummaryEnabled'
import { useAiDailyChatEnabled } from '../../hooks/useAiDailyChatEnabled'
import { useAiImageGenerationEnabled } from '../../hooks/useAiImageGenerationEnabled'
import { useSecondLock } from '../../hooks/useSecondLock'
import { useInvisibleLock } from '../../hooks/useInvisibleLock'
import { useEditorMetricsStore } from '../../stores/editorMetricsStore'
import { useJournalStore } from '../../stores/journalStore'
import { useTabStore } from '../../stores/tabStore'
import { useChatPendingAttachmentsStore } from '../../stores/chatPendingAttachmentsStore'
import { randomId } from '../../lib/randomId'
import { cn } from '../../lib/cn'
import { clampSubmenuVerticalPosition } from '../../lib/submenuPosition'
import { InvisibleVaultMarkModal } from './InvisibleVaultMarkModal'

interface EntryContextMenuProps {
  entryId: string
  entryDate: number
  /** The entry's current `journal_id` — used to exclude the source journal
   *  from the "Move to another journal" submenu so the user can't pick a
   *  no-op destination. */
  entryJournalId: string
  /** Current emotion on the entry. Drives the checkmark in the emotion
   *  submenu and whether the "Clear emotion" row is rendered. */
  entryEmotion: EmotionKey | null
  /** Whether the entry currently has a location set. Drives the
   *  "Clear location" row in the location submenu. */
  entryHasLocation: boolean
  entryLocked: boolean
  entryInvisible: boolean
  anchor: { x: number; y: number }
  onClose: () => void
  onDelete?: () => void
  /** Called when the user picks "Summarize". The parent owns the
   *  EntrySummaryModal so the menu can dismiss immediately instead of
   *  lingering behind the modal scrim. */
  onSummarize: () => void
  /** Called when the user picks "Generate image". The parent owns the
   *  GenerateImageDialog, mirroring `onSummarize`. */
  onGenerateImage: () => void
  /** Called when the user picks "Version history". The parent owns the
   *  VersionHistoryModal, mirroring `onSummarize`. */
  onVersionHistory?: () => void
  /** Open this entry in a brand-new tab. Owned by the parent so the
   *  tab-store call lives next to the rest of the EntryCard's tab
   *  handling (Cmd-click on the card uses the same helper). */
  onOpenInNewTab: () => void
  onSecondLockIntro: () => void
  /** Called when the user picks "Add a location". The parent owns the
   *  create/apply modal so the menu can dismiss immediately. */
  onAddLocation: () => void
}

type Submenu = null | 'date' | 'tags' | 'journal' | 'emotion' | 'location' | 'ai' | 'lock'

/**
 * Right-click menu for an entry card. Built as a floating layer
 * positioned at the click point (clamped to viewport). Items:
 *
 *   - Lock → Second lock / Invisible lock (always visible; mark-while-locked via modal)
 *   - Edit date  → inline `MiniDatePicker` opens to the right
 *   - AI → Generate title / Start a chat / Summarize / Generate image
 *          (each gated by its own feature flag)
 *   - Add tags   → inline `TagPickerPopover` opens to the right
 *   - Delete     → defers to the parent's delete confirmation flow
 *
 * Closes on outside-click and Escape; a submenu is its own pane that
 * stays open until the user picks or clicks out. Submenu parents open
 * on hover (or click); clicking an already-open parent is a no-op so
 * the pane is not toggled shut.
 */
export function EntryContextMenu({
  entryId,
  entryDate,
  entryJournalId,
  entryEmotion,
  entryHasLocation,
  entryLocked,
  entryInvisible,
  anchor,
  onClose,
  onDelete,
  onSummarize,
  onGenerateImage,
  onVersionHistory,
  onOpenInNewTab,
  onSecondLockIntro,
  onAddLocation,
}: EntryContextMenuProps) {
  const { t } = useTranslation('editor')
  // Gate each AI item on the actual backend flag for that feature so
  // the menu only shows what the user can actually run right now.
  const titleSuggestionsEnabled = useAiTitleSuggestionsEnabled()
  const summariesEnabled = useAiMultiEntrySummaryEnabled()
  // Daily Chat can be disabled entirely (`ai_daily_chat_enabled`); when
  // null (first hydration in flight) we suppress the chat item to avoid a
  // flash. The "AI" parent only renders once at least one AI item is
  // confirmed on, so a `null` here is fine — it just keeps the parent
  // collapsed until hydration resolves.
  const dailyChatEnabled = useAiDailyChatEnabled()
  // Image generation has a four-state probe (see the hook). Only the fully
  // usable `'enabled'` state gets a row here — the menu has no room for the
  // disabled-with-tooltip affordance the editor footer uses, and every other
  // item in this menu is show/hide-gated the same way.
  const imageGenEnabled = useAiImageGenerationEnabled() === 'enabled'
  const secondLock = useSecondLock(false)
  const invisibleLock = useInvisibleLock(false)
  const queryClient = useQueryClient()
  const { start: startTitleStream } = useTitleStream()
  const setEntryDateUserEdited = useEditorMetricsStore((s) => s.setEntryDateUserEdited)
  // Read journals straight off the global store (already populated at app
  // root). Avoid `useJournals()` here — that hook re-fetches on mount, and
  // up to 30 mounted EntryCards would each trigger a refetch on right-click.
  const allJournals = useJournalStore((s) => s.journals)
  const targetJournals = allJournals.filter((j) => j.id !== entryJournalId && !j.is_deleted)
  const menuRef = useRef<HTMLDivElement>(null)
  const parentPaneRef = useRef<HTMLDivElement>(null)
  const submenuPaneRef = useRef<HTMLDivElement>(null)
  const dateSubmenuPaneRef = useRef<HTMLDivElement>(null)
  const journalItemRef = useRef<HTMLButtonElement>(null)
  const emotionItemRef = useRef<HTMLButtonElement>(null)
  const locationItemRef = useRef<HTMLButtonElement>(null)
  const aiItemRef = useRef<HTMLButtonElement>(null)
  const lockItemRef = useRef<HTMLButtonElement>(null)
  const [submenu, setSubmenu] = useState<Submenu>(null)
  // Real measured heights of the parent pane and the currently open
  // submenu pane. Initial render falls back to the constants below,
  // then `useLayoutEffect` swaps in the actual values before paint so
  // the viewport clamp matches what's really on screen — the parent
  // menu has a variable number of items (AI flags / journal count /
  // delete-availability), and submenus shrink-to-fit short content.
  const [measuredMenuH, setMeasuredMenuH] = useState<number | null>(null)
  const [measuredSubmenuH, setMeasuredSubmenuH] = useState<number | null>(null)
  const [measuredSubmenuW, setMeasuredSubmenuW] = useState<number | null>(null)
  const [measuredDateSubmenuH, setMeasuredDateSubmenuH] = useState<number | null>(null)
  // Vertical offset (px) used to align each row-anchored submenu pane
  // with its triggering row instead of the top of the parent menu.
  // Measured when the submenu opens — `offsetTop` is stable while the
  // menu is mounted. No bottom-edge clamp here on purpose: keeping the
  // pane glued to its row is the WHOLE point of the alignment. To
  // prevent overflow we instead push the parent menu up (see
  // `submenuFootroom` below).
  const [journalSubmenuOffsetTop, setJournalSubmenuOffsetTop] = useState(0)
  const [emotionSubmenuOffsetTop, setEmotionSubmenuOffsetTop] = useState(0)
  const [locationSubmenuOffsetTop, setLocationSubmenuOffsetTop] = useState(0)
  const [aiSubmenuOffsetTop, setAiSubmenuOffsetTop] = useState(0)
  const [lockSubmenuOffsetTop, setLockSubmenuOffsetTop] = useState(0)
  // Aliases for the location submenu — lazy-loaded the first time the
  // submenu opens. `null` means "not yet fetched"; `[]` means "fetched,
  // none available" (renders the empty-state row).
  const [aliases, setAliases] = useState<LocationAlias[] | null>(null)
  const [invisibleMarkModalOpen, setInvisibleMarkModalOpen] = useState(false)
  // `useLayoutEffect` so the offset is measured and applied before the
  // browser paints the submenu — using `useEffect` causes the pane to
  // render at marginTop=0 for one frame, then jump to the aligned
  // position. Visible as a flicker on slower machines.
  useLayoutEffect(() => {
    if (submenu === 'journal' && journalItemRef.current) {
      setJournalSubmenuOffsetTop(journalItemRef.current.offsetTop)
    } else if (submenu === 'emotion' && emotionItemRef.current) {
      setEmotionSubmenuOffsetTop(emotionItemRef.current.offsetTop)
    } else if (submenu === 'location' && locationItemRef.current) {
      setLocationSubmenuOffsetTop(locationItemRef.current.offsetTop)
    } else if (submenu === 'ai' && aiItemRef.current) {
      setAiSubmenuOffsetTop(aiItemRef.current.offsetTop)
    } else if (submenu === 'lock' && lockItemRef.current) {
      setLockSubmenuOffsetTop(lockItemRef.current.offsetTop)
    }
  }, [submenu])

  // Measure the parent menu pane after mount and whenever its item set
  // changes (AI flags / journal count / delete availability flip).
  // The bottom-edge clamp on `y` below uses this value when available
  // so menus near the viewport bottom don't get their last items cut
  // off — the static `ESTIMATED_H` was too low once we added two more
  // rows.
  useLayoutEffect(() => {
    if (!parentPaneRef.current) return
    const h = parentPaneRef.current.offsetHeight
    if (h > 0) setMeasuredMenuH(h)
  }, [
    titleSuggestionsEnabled,
    summariesEnabled,
    dailyChatEnabled,
    imageGenEnabled,
    targetJournals.length,
    onDelete,
  ])

  // Measure the open submenu pane so we can clamp its `marginTop` and
  // reserve horizontal room for the viewport flip. Re-measures when the
  // submenu type changes or when the location submenu's content
  // resolves async (loading → list / empty). When no submenu is open
  // the value is stale but unused — the clamp branches only fire while
  // a submenu is rendered. Width is measured too: content-fit panes
  // (AI / lock / emotion / …) are much narrower than the old fixed 280px.
  useLayoutEffect(() => {
    if (!submenu || !submenuPaneRef.current) return
    const el = submenuPaneRef.current
    const h = el.offsetHeight
    const w = el.offsetWidth
    if (h > 0) setMeasuredSubmenuH(h)
    if (w > 0) setMeasuredSubmenuW(w)
  }, [
    submenu,
    aliases,
    entryHasLocation,
    entryEmotion,
    entryLocked,
    entryInvisible,
    invisibleLock.activeVaultId,
    targetJournals.length,
    // The AI pane's item count is now 1–4, so its height moves with these.
    titleSuggestionsEnabled,
    summariesEnabled,
    dailyChatEnabled,
    imageGenEnabled,
  ])

  useLayoutEffect(() => {
    if (submenu !== 'date' || !dateSubmenuPaneRef.current) return
    const h = dateSubmenuPaneRef.current.offsetHeight
    if (h > 0) setMeasuredDateSubmenuH(h)
  }, [submenu, entryDate])

  // Lazy-load saved location aliases the first time the location
  // submenu opens. Stash the result so repeated open/close inside one
  // menu lifetime doesn't refetch.
  useEffect(() => {
    if (submenu !== 'location' || aliases !== null) return
    let cancelled = false
    void listLocationAliases()
      .then((result) => {
        if (!cancelled) setAliases(result)
      })
      .catch((err) => {
        console.error('Failed to load location aliases:', err)
        if (!cancelled) setAliases([])
      })
    return () => {
      cancelled = true
    }
  }, [submenu, aliases])

  // Clamp the menu inside the viewport. The menu is ~220px wide; an
  // open submenu adds its own width to the right. Reserve submenu width
  // in the clamp ONLY when a submenu is actually open, so right-clicking
  // near the right edge doesn't yank the menu sideways from the
  // cursor for no apparent reason.
  const MENU_W = 220
  // Ceiling for content-fit submenus (journal / location can grow up to
  // this via `max-w-70`). Date + tags panes size themselves
  // (MiniDatePicker `w-65`, TagPicker `w-70`) and stay near this width.
  const SUB_W_MAX = 280
  const ESTIMATED_H = 280
  // The row-anchored submenus (journal / emotion / location) are
  // rendered as siblings of the parent menu and extend visually below
  // the parent when their row sits low. Reserve extra vertical room
  // when one is open so the parent menu (and therefore the submenu
  // glued to one of its rows) doesn't get pushed off-screen.
  const SUB_MAX_H = 320
  // Staged MiniDatePicker (calendar + time + Apply/Cancel) is taller than
  // the scroll-capped row-anchored submenus — use a generous fallback until
  // the pane is measured.
  const DATE_SUBMENU_ESTIMATED_H = 420
  const rowAnchoredSubmenu =
    submenu === 'journal' ||
    submenu === 'emotion' ||
    submenu === 'location' ||
    submenu === 'ai' ||
    submenu === 'lock'
  // Use the measured submenu height when available, else fall back to
  // the max — both keep the parent pushed up far enough for the glued
  // submenu pane to stay on-screen.
  const submenuH = measuredSubmenuH ?? SUB_MAX_H
  const menuH = measuredMenuH ?? ESTIMATED_H
  const submenuFootroom = rowAnchoredSubmenu ? Math.max(0, submenuH - menuH) : 0
  // Content-fit panes measure real width; date/tags keep the fixed ceiling
  // until/unless we measure them. Prefer measured width so short labels
  // (AI, lock, emotion) don't reserve 280px of empty horizontal space.
  const submenuW = !submenu ? 0 : rowAnchoredSubmenu ? (measuredSubmenuW ?? SUB_W_MAX) : SUB_W_MAX
  const maxX = window.innerWidth - MENU_W - submenuW - 8
  const maxY = window.innerHeight - menuH - submenuFootroom - 8
  const x = Math.max(8, Math.min(anchor.x, maxX))
  const y = Math.max(8, Math.min(anchor.y, maxY))
  // Clamp the row-anchored submenu's `marginTop` so its bottom edge
  // stays on-screen. Without this, picking the "Set location" row near
  // the viewport bottom paints the submenu glued to the row but the
  // last items fall below the visible area. The clamp slides the
  // submenu up just enough to fit — the visual link to its row is
  // softer but still readable thanks to the parent's footroom shift.
  function clampSubmenuMarginTop(rawOffset: number): number {
    if (!measuredSubmenuH) return rawOffset
    return clampSubmenuVerticalPosition({
      anchorTop: y,
      paneHeight: measuredSubmenuH,
      viewportHeight: window.innerHeight,
      preferredMarginTop: rawOffset,
    })
  }

  const dateSubmenuH = measuredDateSubmenuH ?? DATE_SUBMENU_ESTIMATED_H
  const dateSubmenuMarginTop =
    submenu === 'date'
      ? clampSubmenuVerticalPosition({
          anchorTop: y,
          paneHeight: dateSubmenuH,
          viewportHeight: window.innerHeight,
        })
      : 0
  // If a submenu is opening from a parent already clamped near the
  // right edge, flip the submenu to the left of the parent so it
  // doesn't overflow off-screen.
  const submenuOnLeft = !!submenu && x + MENU_W + submenuW + 8 > window.innerWidth

  useEffect(() => {
    // While the mark-modal is open the menu chrome is unmounted; skip
    // outside-click/Escape so they don't tear down the modal host.
    if (invisibleMarkModalOpen) return
    function handleMouseDown(e: MouseEvent) {
      const target = e.target as Node
      if (menuRef.current?.contains(target)) return
      onClose()
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (submenu) setSubmenu(null)
        else onClose()
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKey)
    }
  }, [onClose, submenu, invisibleMarkModalOpen])

  async function handleDateChange(timestamp: number) {
    try {
      await updateEntryDate(entryId, timestamp)
      // Mirror EditorHeader: a manual date pick must block the
      // EXIF-suggestion machinery from overwriting the user's choice
      // if this happens to be the entry currently open in the editor.
      await markEntryDateUserEdited(entryId)
      setEntryDateUserEdited(true)
      emitEntriesChanged()
    } catch (err) {
      console.error('Failed to update entry date:', err)
    }
    onClose()
  }

  function handleDateCancel() {
    setSubmenu(null)
  }

  async function handleGenerateTitle() {
    onClose()
    await startTitleStream(entryId)
  }

  function handleStartChat() {
    // Mint the draft session id here — same pattern as
    // `DailyChatView.handleCreateNew`. The transcript pane will see no
    // row in the DB for this id and render the draft empty state until
    // the first message persists it. Enqueue the source entry against
    // this id so `ChatConversation` can seed its attachment on mount;
    // the queue is consumed exactly once (drain-on-read) so a remount
    // later in the session won't re-add the chip.
    const sessionId = randomId()
    useChatPendingAttachmentsStore.getState().enqueue(sessionId, entryId)
    useTabStore.getState().updateActiveTab({
      activeView: 'chat',
      selectedEntryId: null,
      selectedChatSessionId: sessionId,
      selectedChatSessionIsDraft: true,
    })
    onClose()
  }

  function handleSummarize() {
    // Close the menu and hand control to the parent — owning the
    // modal there avoids the menu lingering in the DOM behind the
    // modal scrim.
    onClose()
    onSummarize()
  }

  function handleGenerateImage() {
    onClose()
    onGenerateImage()
  }

  function handleVersionHistory() {
    onClose()
    onVersionHistory?.()
  }

  async function handleMoveToJournal(targetJournalId: string) {
    try {
      await moveEntryToJournal(entryId, targetJournalId)
      emitEntriesChanged()
    } catch (err) {
      console.error('Failed to move entry to journal:', err)
    }
    onClose()
  }

  async function handleSetEmotion(emotion: EmotionKey | null) {
    try {
      await updateEntryEmotion(entryId, emotion)
      emitEntriesChanged()
    } catch (err) {
      console.error('Failed to update entry emotion:', err)
    }
    onClose()
  }

  function handleSetLocationFromAlias(alias: LocationAlias) {
    onClose()
    void applyLocationAliasToEntry(entryId, alias, entryDate)
  }

  function handleAddLocation() {
    onClose()
    onAddLocation()
  }

  function handleClearLocation() {
    onClose()
    void updateEntryLocation(entryId, null, null, null, null)
      .then(() => {
        emitEntriesChanged()
      })
      .catch((err: unknown) => {
        console.error('Failed to clear entry location:', err)
      })
  }

  function handleDelete() {
    onClose()
    onDelete?.()
  }

  function handleOpenInNewTab() {
    onOpenInNewTab()
    onClose()
  }

  async function handleSecondLockToggle() {
    if (!secondLock.isEnabled) {
      onClose()
      onSecondLockIntro()
      return
    }
    try {
      await secondLock.setEntryLocked(entryId, !entryLocked)
      await queryClient.invalidateQueries({ queryKey: ['entries'] })
      emitEntriesChanged()
    } catch (err) {
      console.error('Failed to update second lock:', err)
    }
    onClose()
  }

  async function handleInvisibleToggle() {
    // Active session: one-click add/remove for the open vault.
    // Locked session + not invisible: open password modal (handled separately).
    try {
      await invisibleLock.markEntryInvisible(entryId, !entryInvisible)
      await queryClient.invalidateQueries({ queryKey: ['entries'] })
      emitEntriesChanged()
    } catch (err) {
      console.error('Failed to update invisible lock:', err)
    }
    onClose()
  }

  function handleInvisibleMenuClick() {
    if (entryInvisible) {
      void handleInvisibleToggle()
      return
    }
    if (invisibleLock.activeVaultId != null) {
      void handleInvisibleToggle()
      return
    }
    // Locked session: prompt password+confirm without unlocking the session.
    setInvisibleMarkModalOpen(true)
  }

  async function handleInvisibleMarkWithPassword(password: string) {
    await invisibleLock.markEntryInvisibleWithPassword(entryId, password)
    await queryClient.invalidateQueries({ queryKey: ['entries'] })
    emitEntriesChanged()
    onClose()
  }

  // Open a submenu without toggling it shut. Hover and click both call
  // this so re-clicking an already-open parent is a no-op (React bails
  // out when the state value is unchanged).
  function openSubmenu(next: NonNullable<Submenu>) {
    setSubmenu(next)
  }

  function closeSubmenu() {
    setSubmenu(null)
  }

  return (
    <FloatingPortal>
      {/* Keep this component mounted while the mark-modal is open so the
          modal is not unmounted by the parent closing the context menu. */}
      {!invisibleMarkModalOpen && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={t('entry_context.menu_aria', { defaultValue: 'Entry actions' })}
          style={{ position: 'fixed', top: y, left: x, zIndex: 60 }}
          className={cn('flex items-start gap-1', submenuOnLeft && 'flex-row-reverse')}
        >
          <div
            ref={parentPaneRef}
            className="border-border-default bg-elevated rounded-xl border p-1 shadow-lg"
            style={{ width: MENU_W }}
          >
            <MenuItem
              icon={<ExternalLink className="size-3.5" />}
              label={t('entry_context.open_in_new_tab', { defaultValue: 'Open in new tab' })}
              onClick={handleOpenInNewTab}
              onMouseEnter={closeSubmenu}
            />
            <MenuItem
              buttonRef={lockItemRef}
              icon={<Lock className="size-3.5" />}
              label={t('entry_context.lock', { defaultValue: 'Lock' })}
              active={submenu === 'lock'}
              onClick={() => openSubmenu('lock')}
              onMouseEnter={() => openSubmenu('lock')}
              hasSubmenu
            />
            <div className="bg-border-default my-1 h-px" />
            <MenuItem
              icon={<Calendar className="size-3.5" />}
              label={t('entry_context.edit_date', { defaultValue: 'Edit date' })}
              active={submenu === 'date'}
              onClick={() => openSubmenu('date')}
              onMouseEnter={() => openSubmenu('date')}
              hasSubmenu
            />
            {(titleSuggestionsEnabled ||
              dailyChatEnabled === true ||
              summariesEnabled ||
              imageGenEnabled) && (
              <MenuItem
                buttonRef={aiItemRef}
                icon={<AiIcon aria-hidden />}
                label={t('entry_context.ai', { defaultValue: 'AI' })}
                active={submenu === 'ai'}
                onClick={() => openSubmenu('ai')}
                onMouseEnter={() => openSubmenu('ai')}
                hasSubmenu
              />
            )}
            <MenuItem
              icon={<History className="size-3.5" />}
              label={t('entry_context.version_history', { defaultValue: 'Version history' })}
              onClick={handleVersionHistory}
              onMouseEnter={closeSubmenu}
            />
            <MenuItem
              icon={<Tag className="size-3.5" />}
              label={t('entry_context.add_tags', { defaultValue: 'Add tags' })}
              active={submenu === 'tags'}
              onClick={() => openSubmenu('tags')}
              onMouseEnter={() => openSubmenu('tags')}
              hasSubmenu
            />
            <MenuItem
              buttonRef={emotionItemRef}
              icon={<Smile className="size-3.5" />}
              label={t('entry_context.set_emotion', { defaultValue: 'Set emotion' })}
              active={submenu === 'emotion'}
              onClick={() => openSubmenu('emotion')}
              onMouseEnter={() => openSubmenu('emotion')}
              hasSubmenu
            />
            <MenuItem
              buttonRef={locationItemRef}
              icon={<MapPin className="size-3.5" />}
              label={t('entry_context.set_location', { defaultValue: 'Set location' })}
              active={submenu === 'location'}
              onClick={() => openSubmenu('location')}
              onMouseEnter={() => openSubmenu('location')}
              hasSubmenu
            />
            {targetJournals.length > 0 && (
              <MenuItem
                buttonRef={journalItemRef}
                icon={<FolderInput className="size-3.5" />}
                label={t('entry_context.move_to_journal', {
                  defaultValue: 'Move to journal',
                })}
                active={submenu === 'journal'}
                onClick={() => openSubmenu('journal')}
                onMouseEnter={() => openSubmenu('journal')}
                hasSubmenu
              />
            )}
            {onDelete && (
              <>
                <div className="bg-border-default my-1 h-px" />
                <MenuItem
                  icon={<Trash2 className="size-3.5" />}
                  label={t('entry_context.delete', { defaultValue: 'Delete entry' })}
                  onClick={handleDelete}
                  onMouseEnter={closeSubmenu}
                  danger
                />
              </>
            )}
          </div>

          {submenu === 'date' && (
            <div
              ref={dateSubmenuPaneRef}
              className="border-border-default bg-elevated rounded-xl border p-3 shadow-lg"
              style={{ marginTop: dateSubmenuMarginTop }}
            >
              <MiniDatePicker
                value={entryDate}
                onChange={handleDateChange}
                onCancel={handleDateCancel}
              />
            </div>
          )}
          {submenu === 'tags' && (
            <TagPickerPopover entryId={entryId} onClose={() => setSubmenu(null)} />
          )}
          {submenu === 'journal' && (
            <div
              ref={submenuPaneRef}
              role="menu"
              aria-label={t('entry_context.move_to_journal_aria', {
                defaultValue: 'Pick destination journal',
              })}
              className="border-border-default bg-elevated max-h-80 w-max max-w-70 overflow-y-auto rounded-xl border p-1 shadow-lg"
              style={{ marginTop: clampSubmenuMarginTop(journalSubmenuOffsetTop) }}
            >
              {targetJournals.map((j) => (
                <button
                  key={j.id}
                  type="button"
                  role="menuitem"
                  onClick={() => void handleMoveToJournal(j.id)}
                  className="text-fg hover:bg-surface-subtle flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium transition-colors"
                >
                  <span
                    aria-hidden="true"
                    className="h-3 w-3 shrink-0 rounded-full"
                    style={{ background: j.color ?? 'var(--color-accent)' }}
                  />
                  <span className="min-w-0 flex-1 truncate">{j.name}</span>
                </button>
              ))}
            </div>
          )}
          {submenu === 'emotion' && (
            <div
              ref={submenuPaneRef}
              role="menu"
              aria-label={t('entry_context.set_emotion_aria', {
                defaultValue: 'Pick an emotion',
              })}
              className="border-border-default bg-elevated max-h-80 w-max overflow-y-auto rounded-xl border p-1 shadow-lg"
              style={{ marginTop: clampSubmenuMarginTop(emotionSubmenuOffsetTop) }}
            >
              {EMOTIONS.map((meta) => {
                const isCurrent = entryEmotion === meta.key
                return (
                  <button
                    key={meta.key}
                    type="button"
                    role="menuitem"
                    onClick={() => void handleSetEmotion(meta.key)}
                    className="text-fg hover:bg-surface-subtle flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium whitespace-nowrap transition-colors"
                  >
                    <span aria-hidden className="text-base leading-none">
                      {meta.emoji}
                    </span>
                    <span>{t(meta.i18nKey)}</span>
                    {isCurrent && <Check className="text-accent size-3.5 shrink-0" />}
                  </button>
                )
              })}
              {entryEmotion !== null && (
                <>
                  <div className="bg-border-default my-1 h-px" />
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void handleSetEmotion(null)}
                    className="text-fg-muted hover:bg-surface-subtle hover:text-fg flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium whitespace-nowrap transition-colors"
                  >
                    <span>
                      {t('entry_context.clear_emotion', { defaultValue: 'Clear emotion' })}
                    </span>
                  </button>
                </>
              )}
            </div>
          )}
          {submenu === 'location' && (
            <div
              ref={submenuPaneRef}
              role="menu"
              aria-label={t('entry_context.set_location_aria', {
                defaultValue: 'Pick a saved location',
              })}
              className={LOCATION_SUBMENU_PANE_CLASS}
              style={{ marginTop: clampSubmenuMarginTop(locationSubmenuOffsetTop) }}
            >
              {aliases === null ? (
                <div className="text-fg-muted px-2 py-1.5 text-xs">…</div>
              ) : aliases.length === 0 ? (
                <div className="text-fg-muted px-2 py-1.5 text-xs whitespace-nowrap">
                  {t('entry_context.no_saved_locations', {
                    defaultValue: 'No saved locations',
                  })}
                </div>
              ) : (
                aliases.map((alias) => (
                  <button
                    key={alias.id}
                    type="button"
                    role="menuitem"
                    onClick={() => handleSetLocationFromAlias(alias)}
                    className="text-fg hover:bg-surface-subtle flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors"
                  >
                    <span className="w-full truncate text-xs font-medium">{alias.label}</span>
                    <span className="text-fg-muted text-2xs w-full truncate">{alias.address}</span>
                  </button>
                ))
              )}
              <div className="bg-border-default my-1 h-px" />
              <button
                type="button"
                role="menuitem"
                onClick={handleAddLocation}
                className="text-fg hover:bg-surface-subtle flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium whitespace-nowrap transition-colors"
              >
                <Plus className="text-fg-muted size-3.5 shrink-0" />
                <span>{t('entry_context.add_location', { defaultValue: 'Add a location' })}</span>
              </button>
              {entryHasLocation && (
                <>
                  <div className="bg-border-default my-1 h-px" />
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void handleClearLocation()}
                    className="text-fg-muted hover:bg-surface-subtle hover:text-fg flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium whitespace-nowrap transition-colors"
                  >
                    <span>
                      {t('entry_context.clear_location', { defaultValue: 'Clear location' })}
                    </span>
                  </button>
                </>
              )}
            </div>
          )}
          {submenu === 'ai' && (
            <div
              ref={submenuPaneRef}
              role="menu"
              aria-label={t('entry_context.ai_aria', { defaultValue: 'AI actions' })}
              className="border-border-default bg-elevated w-max rounded-xl border p-1 shadow-lg"
              style={{ marginTop: clampSubmenuMarginTop(aiSubmenuOffsetTop) }}
            >
              {titleSuggestionsEnabled && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleGenerateTitle()}
                  className="text-fg hover:bg-surface-subtle flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium whitespace-nowrap transition-colors"
                >
                  <SquarePen className="text-fg-muted size-3.5 shrink-0" />
                  <span>
                    {t('entry_context.generate_title', { defaultValue: 'Generate title' })}
                  </span>
                </button>
              )}
              {dailyChatEnabled === true && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={handleStartChat}
                  className="text-fg hover:bg-surface-subtle flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium whitespace-nowrap transition-colors"
                >
                  <MessageSquare className="text-fg-muted size-3.5 shrink-0" />
                  <span>{t('entry_context.start_a_chat', { defaultValue: 'Start a chat' })}</span>
                </button>
              )}
              {summariesEnabled && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={handleSummarize}
                  className="text-fg hover:bg-surface-subtle flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium whitespace-nowrap transition-colors"
                >
                  <FileText className="text-fg-muted size-3.5 shrink-0" />
                  <span>{t('entry_context.summarize', { defaultValue: 'Summarize' })}</span>
                </button>
              )}
              {imageGenEnabled && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={handleGenerateImage}
                  className="text-fg hover:bg-surface-subtle flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium whitespace-nowrap transition-colors"
                >
                  <Palette className="text-fg-muted size-3.5 shrink-0" />
                  <span>
                    {t('entry_context.generate_image', { defaultValue: 'Generate image' })}
                  </span>
                </button>
              )}
            </div>
          )}
          {submenu === 'lock' && (
            <div
              ref={submenuPaneRef}
              role="menu"
              aria-label={t('entry_context.lock_aria', { defaultValue: 'Lock actions' })}
              className="border-border-default bg-elevated w-max rounded-xl border p-1 shadow-lg"
              style={{ marginTop: clampSubmenuMarginTop(lockSubmenuOffsetTop) }}
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => void handleSecondLockToggle()}
                className="text-fg hover:bg-surface-subtle flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium whitespace-nowrap transition-colors"
              >
                <LockKeyhole className="text-fg-muted size-3.5 shrink-0" />
                <span>
                  {entryLocked
                    ? t('entry_context.remove_second_lock', {
                        defaultValue: 'Remove second lock',
                      })
                    : t('entry_context.second_lock', { defaultValue: 'Second lock' })}
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => handleInvisibleMenuClick()}
                className="text-fg hover:bg-surface-subtle flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium whitespace-nowrap transition-colors"
              >
                <EyeOff className="text-fg-muted size-3.5 shrink-0" />
                <span>
                  {entryInvisible
                    ? t('entry_context.remove_invisible', {
                        defaultValue: 'Remove from invisible',
                      })
                    : invisibleLock.activeVaultId != null
                      ? t('entry_context.add_to_invisible_vault', {
                          defaultValue: 'Add to invisible vault',
                        })
                      : t('entry_context.invisible_lock_ellipsis', {
                          defaultValue: 'Invisible lock…',
                        })}
                </span>
              </button>
            </div>
          )}
        </div>
      )}
      <InvisibleVaultMarkModal
        open={invisibleMarkModalOpen}
        onClose={() => {
          setInvisibleMarkModalOpen(false)
          onClose()
        }}
        onSubmit={handleInvisibleMarkWithPassword}
      />
    </FloatingPortal>
  )
}

interface MenuItemProps {
  icon: React.ReactNode
  label: string
  onClick: () => void
  onMouseEnter?: () => void
  active?: boolean
  hasSubmenu?: boolean
  danger?: boolean
  buttonRef?: React.Ref<HTMLButtonElement>
}

function MenuItem({
  icon,
  label,
  onClick,
  onMouseEnter,
  active,
  hasSubmenu,
  danger,
  buttonRef,
}: MenuItemProps) {
  return (
    <button
      ref={buttonRef}
      type="button"
      role="menuitem"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium transition-colors',
        active && 'bg-border-subtle',
        danger ? 'text-fg hover:bg-danger/10 hover:text-danger' : 'text-fg hover:bg-surface-subtle',
      )}
    >
      <span className={cn('shrink-0', danger ? 'text-danger' : 'text-fg-muted')}>{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {hasSubmenu && (
        <ChevronRight className="text-fg-muted size-2.5 shrink-0" strokeWidth={2.25} aria-hidden />
      )}
    </button>
  )
}
