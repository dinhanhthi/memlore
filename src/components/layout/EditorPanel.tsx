import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  setEditorMounted,
  registerActiveEditorInstance,
  isActiveEditorInstance,
} from '../../lib/editorMount'
import * as Y from 'yjs'
import { convertFileSrc } from '@tauri-apps/api/core'
import type { Editor as TipTapEditor } from '@tiptap/core'
import {
  getEntry,
  updateEntry,
  getEntryContent,
  saveEntryContent,
  updateEntryEmotion,
  updateEntryLocation,
  toggleFavorite,
  listMediaForEntry,
  snapshotEntryVersion,
  getEntryVersionContent,
} from '../../lib/tauri'
import { applyEntryWeather } from '../../hooks/applyEntryWeather'
import type { MediaRow } from '../../lib/tauri'
import {
  createYDoc,
  deserializeYDoc,
  serializeYDoc,
  extractPlainText,
  extractMediaIdsFromYDoc,
  snapshotToPmJson,
} from '../../lib/yjs'
import { emitEntryVersionsChanged } from '../../lib/versionEvents'
import { emitEntryDocSaved } from '../../lib/inlineMediaDeletionTracker'
import { bumpSaveGeneration, isLatestSaveGenerationForEntry } from '../../lib/saveGeneration'
import type { RestoreEntryVersionDetail } from '../../lib/versionEvents'
import { setPendingRestore, getPendingRestore } from '../../lib/pendingRestore'
import { toast } from '../../lib/toast'
import { useTabStore } from '../../stores/tabStore'
import { Editor } from '../editor/Editor'
import { EditorFindBar } from '../editor/EditorFindBar'
import { ChatBackRefBanner } from '../editor/ChatBackRefBanner'
import { Callout } from '../common/Callout'
import { EmotionPicker } from '../common/EmotionPicker'
import type { EmotionKey } from '../../types/entry'
import { SuggestTitlePill } from '../editor/SuggestTitlePill'
import { GoDeeperPopover } from '../editor/GoDeeperPopover'
import type { GenerateImageResult } from '../../lib/tauri'
import { EntryHighlightsPopover } from '../entries/EntryHighlightsPopover'
import { useAiEntryHighlightsEnabled } from '../../hooks/useAiEntryHighlightsEnabled'
import { useAiGoDeeperEnabled } from '../../hooks/useAiGoDeeperEnabled'
import { useAiContinueWritingEnabled } from '../../hooks/useAiContinueWritingEnabled'
import { useAiPersonaEnabled } from '../../hooks/useAiPersonaEnabled'
import { useEntryHighlights } from '../../hooks/useEntryHighlights'
import { useGoDeeper } from '../../hooks/useGoDeeper'
import { useEditorProseVoice } from '../../hooks/useEditorProseVoice'
import { PenLine } from 'lucide-react'
import { useUpdateActiveTab } from '../../hooks/useActiveTab'
import { useChatSessionForEntry } from '../../hooks/useChatSessionForEntry'
import { useChatAppendToApply } from '../../hooks/useChatAppendToApply'
import { useEditorMetricsStore } from '../../stores/editorMetricsStore'
import { useEditorDistractionStore } from '../../stores/editorDistractionStore'
import { editorContentColumnClass } from '../../lib/editorLayout'
import { useMathExtensions } from '../../hooks/useMathExtensions'
import { useEditorEmojiShortcodesHydrated } from '../../hooks/useEditorEmojiShortcodesEnabled'
import { useEditorRightToLeftEnabled } from '../../hooks/useEditorRightToLeftEnabled'
import { useEntryStore } from '../../stores/entryStore'
import { emitEntryPatched, type EntryPatchDetail } from '../../hooks/useEntries'
import { useJournalStore } from '../../stores/journalStore'
import { useTemplateStore } from '../../stores/templateStore'
import { useChatDraftStore } from '../../stores/chatDraftStore'
import { useInvisibleLockStore } from '../../stores/invisibleLockStore'
import { useSecondLockStore } from '../../stores/secondLockStore'
import type { Template } from '../../types/template'

const AUTO_SAVE_DEBOUNCE_MS = 1500
// Version history (Phase 3): a session = one open of the entry, or
// resumption of editing after this long an idle gap. See the
// session-snapshot refs below.
const SESSION_IDLE_MS = 10 * 60 * 1000

interface EditorPanelProps {
  entryId: string | null
}

type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'error'

export function EditorPanel({ entryId }: EditorPanelProps) {
  const { t } = useTranslation('editor')
  const { t: tAi } = useTranslation('ai')
  const [entry, setEntry] = useState<Awaited<ReturnType<typeof getEntry>>>(null)
  const [notFound, setNotFound] = useState(false)
  const [title, setTitle] = useState('')
  const [savedTitle, setSavedTitle] = useState('')
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved')
  const [saveError, setSaveError] = useState<string | null>(null)
  const updateActiveTab = useUpdateActiveTab()
  const activeVaultId = useInvisibleLockStore((s) => s.activeVaultId)
  const lockedView = useSecondLockStore((s) => s.lockedView())

  // Mirror save state into the active tab's `dirty` flag so the global
  // <FooterBar/> (Chunk D) can render Saving…/Saved/Error without us
  // having to colocate the indicator with the editor.
  useEffect(() => {
    const isTitleUnsaved = title !== savedTitle
    const dirty = saveStatus === 'saving' || saveStatus === 'unsaved' || isTitleUnsaved
    updateActiveTab({ dirty })
  }, [saveStatus, title, savedTitle, updateActiveTab])
  const [doc, setDoc] = useState<Y.Doc | null>(null)
  const [pendingTemplate, setPendingTemplate] = useState<Template | null>(null)
  const [pendingChatDraftHtml, setPendingChatDraftHtml] = useState<string | null>(null)
  // Phase 4 T2 — "Update the entry" append handoff from Daily Chat. The
  // consume/cache/reset logic (reactive + StrictMode-safe) lives in the hook so
  // it can carry its own regression test; see `useChatAppendToApply`. The
  // returned value survives until <Editor/> mounts and applies it via the
  // nonce-guarded effect from Phase 4 T1. NOTE: the entry-load effect below must
  // NOT null this — the hook owns the reset (keyed on entryId alone).
  const appendToApply = useChatAppendToApply(entryId)
  const [orphanedMedia, setOrphanedMedia] = useState<MediaRow[]>([])
  const editorRef = useRef<TipTapEditor | null>(null)
  const [showEmotionPicker, setShowEmotionPicker] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [findFocusTick, setFindFocusTick] = useState(0)
  const journals = useJournalStore((s) => s.journals)
  const journal = entry ? (journals.find((j) => j.id === entry.journal_id) ?? null) : null
  const distractionMode = useEditorDistractionStore((s) => s.distractionMode)
  const rightToLeftEnabled = useEditorRightToLeftEnabled()

  // Memoized word count for the AI emotion-suggestion gate (Phase 6 A6).
  // Recomputing the split on every render is cheap, but the picker
  // mounts/remounts based on `showEmotionPicker` and the parent
  // re-renders on every keystroke — gate the work to content-text
  // changes only.
  const entryWordCount = useMemo(
    () => entry?.content_text?.trim().split(/\s+/).filter(Boolean).length ?? 0,
    [entry?.content_text],
  )
  // Char count drives the SuggestTitlePill's >200-char floor. Mirrors
  // the backend's `SUGGEST_TITLE_MIN_CHARS` (chunk-a7).
  const entryCharCount = useMemo(() => entry?.content_text?.length ?? 0, [entry?.content_text])

  // Phase 6 v2 R7 / R8 — gates the AI Highlights card and Go-Deeper
  // button under the editor. Flags are global — no need to re-probe
  // per entry; the Settings → AI panel will fire its own refresh when
  // the toggle flips, and probing on every navigation just burns IPC
  // for the same booleans.
  const aiEntryHighlightsEnabled = useAiEntryHighlightsEnabled()
  const aiGoDeeperEnabled = useAiGoDeeperEnabled()
  const aiContinueWritingEnabled = useAiContinueWritingEnabled()
  const aiPersonaEnabled = useAiPersonaEnabled()
  // Persona OFF → keep BOTH prose affordances visible but disabled with a
  // tooltip that names the fix, rather than making them silently vanish.
  const proseVoiceDisabledReason =
    aiPersonaEnabled === false ? tAi('error.AI_PERSONA_DISABLED') : undefined

  // Lift the AI feature hooks here so the streaming/cached state
  // survives popover open/close in <EditorFooter/>. The popovers are
  // pure views that read from these hooks via render-props.
  const highlights = useEntryHighlights(entryId)
  const goDeeper = useGoDeeper()
  const editorProseVoice = useEditorProseVoice()
  // Phase 4 T3 — Daily Chat ⇄ Entry link. Resolves the chat session this
  // entry was generated from (if any) so the editor can show a back-ref
  // banner. `sessionRef` is null while loading or when the entry has no
  // linked session; no error state is needed since null already means
  // "no source chat".
  const { sessionRef: chatSource } = useChatSessionForEntry(entryId)
  const emojiHydrated = useEditorEmojiShortcodesHydrated()
  const {
    extensions: mathExtensions,
    ready: mathReady,
    mathHydrated,
    needsMath,
    loadFailed: mathLoadFailed,
  } = useMathExtensions(doc)

  // Ref for debounce timer
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Forward-declared ref to triggerAutoSave so the entry-load cleanup
  // (which runs before triggerAutoSave is defined in the source order)
  // can flush a pending debounced save before unmounting the doc.
  const triggerAutoSaveRef = useRef<((ydoc: Y.Doc, id: string) => void) | null>(null)
  // Per-entry generation: a stale in-flight snapshot of A must not emit
  // after a newer save of A, but a save of B must not suppress A's emit.
  const saveGenerationByEntryRef = useRef<Record<string, number>>({})
  // Stores the plain-text content at the time the entry was loaded. The
  // Collaboration extension fires onUpdate once on mount to sync Yjs state
  // into ProseMirror; that event produces the same text as what was loaded,
  // so comparing against this baseline lets us ignore it without relying on
  // fragile microtask/macrotask ordering.
  // Tracks the last text that was either loaded from disk or successfully saved.
  // The Collaboration extension fires onUpdate once on initial sync with the
  // same text that was loaded — comparing against this ref ignores that event.
  // Updated on every successful save so that a user who reverts to a previously-
  // saved state still gets their revert persisted correctly.
  const lastPersistedTextRef = useRef<string>('')
  // Tracks the Yjs state vector at last save. Compared against current state
  // to detect changes that don't produce text (e.g. image/media insertions).
  const lastPersistedYjsStateRef = useRef<Uint8Array | null>(null)
  // Ref for current entry id (avoid stale closure in callbacks)
  const entryIdRef = useRef<string | null>(entryId)
  useEffect(() => {
    entryIdRef.current = entryId
  }, [entryId])
  // Ref for current doc (avoid stale closure when entry changes)
  const docRef = useRef<Y.Doc | null>(doc)
  useEffect(() => {
    docRef.current = doc
  }, [doc])

  // ── Version history: session-based snapshot (Phase 3) ──────────────────────
  // All four refs are reset whenever the open entryId changes (see the
  // entry-load effect below).
  //
  // baselineBytesRef: the last-saved `yjs_doc` snapshot to capture next.
  // Initialized from the loaded `contentBytes`; updated to the just-saved
  // bytes after every autosave so a mid-session idle-boundary snapshot
  // captures the state at the start of the idle-broken burst, not the
  // stale load-time state. Null/empty means "never saved" — skip snapshotting.
  const baselineBytesRef = useRef<Uint8Array | null>(null)
  // baselinePreviewRef: `preview_text` matching baselineBytesRef.
  const baselinePreviewRef = useRef<string>('')
  // sessionSnapshotTakenRef: whether the current session already produced a
  // snapshot (at most one snapshot per session).
  const sessionSnapshotTakenRef = useRef<boolean>(false)
  // lastEditAtRef: timestamp (ms) of the last user content edit, used to
  // detect the idle-boundary that starts a new session mid-open.
  const lastEditAtRef = useRef<number>(0)

  // ── Version history: CRDT-safe restore (Phase 3) ────────────────────────────
  // Pending-restore state lives in a MODULE-LEVEL singleton
  // (`lib/pendingRestore.ts`), not a per-instance ref. Restoring a version
  // for an entry that isn't the active editor can flip `activeView` (e.g.
  // away from the map view), which unmounts the map overlay's EditorPanel
  // entirely and mounts a fresh main EditorPanel instance. A per-instance
  // ref set by the overlay would be destroyed with it and never reach the
  // new instance; the singleton survives that handoff. See
  // `setPendingRestore`/`getPendingRestore` and `attemptPendingRestore`
  // below, which is the sole owner of clearing it (on consume for a match,
  // or on abandon for a mismatch).
  // Forward-declared ref so `handleEditorReady` (defined earlier in source
  // order) can invoke `attemptPendingRestore` (defined later, once
  // editorRef/entryIdRef are in scope) without a TDZ error — mirrors
  // `triggerAutoSaveRef` above.
  const attemptPendingRestoreRef = useRef<(() => void) | null>(null)
  // Identifies this EditorPanel instance so the restore-event listener
  // (below) can ignore the event when a different mounted instance (main
  // panel vs the map overlay in `LocationsMapView`) is the current one —
  // see `lib/editorMount.ts`. Registered once per component mount, not
  // per-entry, since the same instance handles every entry it loads.
  const editorInstanceIdRef = useRef<number>(0)
  useEffect(() => {
    editorInstanceIdRef.current = registerActiveEditorInstance()
  }, [])

  // Flip the global editorMounted flag so the App.tsx ⌘F handler knows
  // whether to swallow the chord (dispatch memlore:editor-find) or let
  // the browser's native Find handle it. Gated on `doc` so the flag is
  // only true when an actual TipTap editor is rendered — empty/loading
  // panels don't swallow ⌘F.
  useEffect(() => {
    if (!doc) return
    setEditorMounted(true)
    return () => setEditorMounted(false)
  }, [doc])

  // Open the find bar when the global ⌘F chord fires (dispatched by App.tsx).
  // Bumps findFocusTick on every call so ⌘F while the bar is already open
  // re-selects the input — same behaviour as standard desktop find UIs.
  useEffect(() => {
    const handler = () => {
      // When multiple EditorPanels are mounted (e.g. Map overlay), only the
      // one whose editor is currently focused should respond. We also accept
      // the case where this panel's find bar is already open — focus is then
      // on the bar's input (outside the contenteditable, so `isFocused` is
      // false), but ⌘F should still re-grab focus + re-select the query.
      if (!editorRef.current?.isFocused && !findOpen) return
      setFindOpen(true)
      setFindFocusTick((n) => n + 1)
    }
    window.addEventListener('memlore:editor-find', handler)
    return () => window.removeEventListener('memlore:editor-find', handler)
  }, [findOpen])

  // Close the find bar when the user switches entries — the editor is
  // re-mounting anyway so there are no highlights to clear and no focus
  // to restore to the old editor instance.
  useEffect(() => {
    setFindOpen(false)
  }, [entryId])

  // Ref that records which entry we've already drained from the template
  // pending queue. React StrictMode runs the entry-load effect twice in dev;
  // without this guard the first pass would consume the template and the
  // second pass would clear it before the editor ever sees it — silently
  // dropping the "pick template → new entry with that template" flow.
  // Persist the consumed value (not just a marker) so a StrictMode
  // double-effect doesn't lose the template: the first pass calls the
  // destructive `consumePendingTemplate` and stores the result here,
  // the second pass re-uses it instead of calling the store again.
  const consumedTemplateForEntryRef = useRef<{
    entryId: string
    template: Template | null
  } | null>(null)
  // Same StrictMode guard for the Daily-Chat → "Save as entry" handoff:
  // a freshly-created entry seeds its first content via this queue
  // exactly once, even though the entry-load effect runs twice in dev.
  // We persist the *consumed value* (not just a marker) here so the
  // second StrictMode pass — which skips the destructive `consume`
  // store call — still has the HTML to setState. Without this, the
  // second pass would call `setPendingChatDraftHtml(null)` and erase
  // the value the first pass just stored.
  const consumedChatDraftForEntryRef = useRef<{ entryId: string; html: string | null } | null>(null)

  // Load entry and Yjs doc when entryId changes
  useEffect(() => {
    if (!entryId) {
      return () => {
        setEntry(null)
        setNotFound(false)
        setDoc(null)
        setPendingTemplate(null)
        setPendingChatDraftHtml(null)
        // `appendToApply` is owned by `useChatAppendToApply` (reset keyed on
        // entryId, which fires on entryId → null too), so it's not reset here.
        useEditorMetricsStore.getState().clear()
        baselineBytesRef.current = null
        baselinePreviewRef.current = ''
        sessionSnapshotTakenRef.current = false
        lastEditAtRef.current = 0
      }
    }

    // Reset loading state and kick off async fetch — setState in .then()
    // avoids calling setState synchronously in the effect body.
    let cancelled = false

    // Consume any queued TemplatePicker handoff exactly once per entryId —
    // StrictMode-safe. The consumed value is cached in the ref so the
    // second StrictMode pass (which must not call the destructive
    // store API again) can still recover the template instead of
    // setStating with `null`.
    if (consumedTemplateForEntryRef.current?.entryId !== entryId) {
      const template = useTemplateStore.getState().consumePendingTemplate(entryId) ?? null
      consumedTemplateForEntryRef.current = { entryId, template }
    }
    const consumedTemplate = consumedTemplateForEntryRef.current.template

    // Drain the chat-draft queue at most once per entry id. The
    // *consumed value* lives in the ref (not just a marker), so the
    // second StrictMode pass — which must not call the destructive
    // store API again — still recovers the HTML and we don't setState
    // with a stale `null`.
    if (consumedChatDraftForEntryRef.current?.entryId !== entryId) {
      const html = useChatDraftStore.getState().consumePendingChatDraft(entryId)
      consumedChatDraftForEntryRef.current = { entryId, html }
    }
    const consumedChatDraftHtml = consumedChatDraftForEntryRef.current.html

    Promise.all([getEntry(entryId, activeVaultId), getEntryContent(entryId, activeVaultId)])
      .then(([fetched, contentBytes]) => {
        if (cancelled) return
        setPendingTemplate(consumedTemplate)
        setPendingChatDraftHtml(consumedChatDraftHtml)
        // null = missing, deleted, or invisible while the vault session is locked.
        // Never leave a stale selectedEntryId / ghost editor — deselect like the
        // locked / invisible guard paths below.
        if (!fetched) {
          setEntry(null)
          setNotFound(true)
          setDoc(null)
          useEditorMetricsStore.getState().clear()
          updateActiveTab({ selectedEntryId: null, dirty: false })
          return
        }
        if (fetched.is_locked && useSecondLockStore.getState().lockedView() !== 'revealed') {
          setEntry(null)
          setNotFound(false)
          setDoc(null)
          useEditorMetricsStore.getState().clear()
          updateActiveTab({ selectedEntryId: null, dirty: false })
          return
        }
        if (fetched.is_invisible && !useInvisibleLockStore.getState().activeVaultId) {
          setEntry(null)
          setNotFound(false)
          setDoc(null)
          useEditorMetricsStore.getState().clear()
          updateActiveTab({ selectedEntryId: null, dirty: false })
          return
        }
        setEntry(fetched)
        // Cache in the canonical lookup so tab-title resolution works
        // even when the active scope's entry list doesn't include this
        // entry (e.g. opened from search or a deep link).
        useEntryStore.getState().mergeEntries([fetched])
        setNotFound(false)
        setSaveStatus('saved')
        setSaveError(null)
        const t = fetched.title ?? ''
        setTitle(t)
        setSavedTitle(t)

        // Build Y.Doc: restore from stored bytes or create fresh
        let ydoc: Y.Doc
        if (contentBytes && contentBytes.length > 0) {
          ydoc = deserializeYDoc(new Uint8Array(contentBytes))
        } else {
          ydoc = createYDoc(entryId)
        }
        setDoc(ydoc)

        // Seed live metrics from the freshly-loaded Y.Doc so the FooterBar
        // shows the correct count immediately on entry switch (otherwise it
        // lingers at 0 until the user types).
        const text = extractPlainText(ydoc)
        const words = text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length
        useEditorMetricsStore.getState().setMetrics(entryId, words, text.length)

        // Record the loaded text so handleEditorUpdate can detect the
        // Collaboration extension's initial sync event (which fires onUpdate
        // without the user having changed anything).
        lastPersistedTextRef.current = text
        lastPersistedYjsStateRef.current = Y.encodeStateVector(ydoc)

        // Version history (Phase 3): the freshly-loaded bytes are the
        // baseline the first session-snapshot will capture. An entry with
        // no stored content yet (contentBytes empty) has nothing to
        // snapshot — leave baselineBytesRef null so the session-snapshot
        // guard skips it. A new session starts on every load.
        baselineBytesRef.current =
          contentBytes && contentBytes.length > 0 ? new Uint8Array(contentBytes) : null
        baselinePreviewRef.current = fetched.preview_text ?? ''
        sessionSnapshotTakenRef.current = false
        lastEditAtRef.current = Date.now()
      })
      .catch(() => {
        if (!cancelled) {
          setNotFound(true)
          // Do NOT clear `appendToApply` here (it's the hook's state): this
          // `.catch()` runs on the same effect whose deps include
          // `activeVaultId`, so a transient load failure during a reveal
          // toggle would strand the already-consumed append (the hook's consume
          // effect won't re-run to restore it). Leaving it set lets a later
          // successful reload of THIS entry still apply it; leaking to a
          // DIFFERENT entry is prevented by the hook's entryId-keyed reset.
        }
      })

    return () => {
      cancelled = true
      // Flush any pending debounced auto-save before tearing the editor
      // state down — without this, switching entries (or closing the map
      // overlay) within the 1500ms debounce window silently drops whatever
      // the user typed last. We go through the ref because triggerAutoSave
      // is declared further down in this component.
      if (autoSaveTimer.current) {
        clearTimeout(autoSaveTimer.current)
        autoSaveTimer.current = null
        if (docRef.current && entryIdRef.current) {
          triggerAutoSaveRef.current?.(docRef.current, entryIdRef.current)
        }
      }
      setEntry(null)
      setNotFound(false)
      setDoc(null)
      setSaveStatus('saved')
      setSaveError(null)
      // NOTE: clearing `appendToApply` lives in `useChatAppendToApply`'s
      // entryId-keyed reset — deliberately NOT here, so a
      // `activeVaultId`/`updateActiveTab` change (which re-runs this effect
      // without entryId changing) can't null a queued-but-unapplied append.
      lastPersistedTextRef.current = ''
      lastPersistedYjsStateRef.current = null
      useEditorMetricsStore.getState().clear()
      baselineBytesRef.current = null
      baselinePreviewRef.current = ''
      sessionSnapshotTakenRef.current = false
      lastEditAtRef.current = 0
      // Pending-restore state is a module-level singleton (see its
      // declaration above), not component state — nothing to reset here.
    }
  }, [entryId, activeVaultId, updateActiveTab])

  useEffect(() => {
    if (!entry?.is_locked || lockedView === 'revealed') return
    setEntry(null)
    setNotFound(false)
    setDoc(null)
    setSaveStatus('saved')
    setSaveError(null)
    useEditorMetricsStore.getState().clear()
    updateActiveTab({ selectedEntryId: null, dirty: false })
  }, [entry?.is_locked, lockedView, updateActiveTab])

  useEffect(() => {
    if (!entry?.is_invisible || activeVaultId) return
    setEntry(null)
    setNotFound(false)
    setDoc(null)
    setSaveStatus('saved')
    setSaveError(null)
    useEditorMetricsStore.getState().clear()
    updateActiveTab({ selectedEntryId: null, dirty: false })
  }, [entry?.is_invisible, activeVaultId, updateActiveTab])

  // Auto-save callback — serializes Y.Doc and calls backend
  const triggerAutoSave = useCallback((ydoc: Y.Doc, currentEntryId: string) => {
    const gen = bumpSaveGeneration(saveGenerationByEntryRef.current, currentEntryId)
    setSaveStatus('saving')
    const bytes = serializeYDoc(ydoc)
    const yjsDoc = Array.from(bytes)
    const contentText = extractPlainText(ydoc)
    const previewText = contentText.slice(0, 150)

    saveEntryContent(currentEntryId, yjsDoc, contentText, previewText)
      .then(() => {
        // Only the latest in-flight save of THIS entry emits.
        if (!isLatestSaveGenerationForEntry(saveGenerationByEntryRef.current, currentEntryId, gen))
          return
        setSaveStatus('saved')
        setSaveError(null)
        lastPersistedTextRef.current = contentText
        lastPersistedYjsStateRef.current = Y.encodeStateVector(ydoc)
        // Version history (Phase 3): the just-saved bytes become the next
        // session-snapshot baseline, so a mid-session idle-boundary snapshot
        // captures the state at the start of the idle-broken burst rather
        // than the stale load-time state.
        baselineBytesRef.current = bytes
        baselinePreviewRef.current = previewText
        // entriesById is still populated for the active entry via mergeEntries
        // calls elsewhere in EditorPanel; that map (not the paged entries array)
        // is the source of truth for by-id lookups after Phase 5 pagination.
        const current = useEntryStore.getState().entriesById[currentEntryId]
        if (current) {
          useEntryStore.getState().updateEntry({ ...current, preview_text: previewText })
        }
        // In-place patch on the paginated EntryList — no refetch, no
        // "Loading" placeholder flash during typing. The patched fields
        // (preview_text + word count if exposed later) are the only ones
        // that move per keystroke; everything else stays untouched.
        emitEntryPatched(currentEntryId, { preview_text: previewText })
        emitEntryDocSaved(currentEntryId)
      })
      .catch((err: unknown) => {
        if (!isLatestSaveGenerationForEntry(saveGenerationByEntryRef.current, currentEntryId, gen))
          return
        setSaveStatus('error')
        setSaveError(err instanceof Error ? err.message : 'Auto-save failed')
      })
  }, [])

  // Keep the forward-declared ref in sync so the entry-load cleanup can
  // flush pending saves without a TDZ on `triggerAutoSave`.
  useEffect(() => {
    triggerAutoSaveRef.current = triggerAutoSave
  }, [triggerAutoSave])

  // Refetch the entry's metadata when something outside this panel
  // mutates it — e.g. the EntryCard context menu changing date, tags,
  // or the AI title-suggestion controller persisting a generated
  // title. Refetches only the metadata row; the Y.Doc is untouched
  // so live edits in progress are safe.
  useEffect(() => {
    if (!entryId) return
    const handler = () => {
      void getEntry(entryId, activeVaultId).then((fetched) => {
        if (!fetched) return
        setEntry(fetched)
        // Sync the canonical lookup map so tab titles on OTHER tabs that
        // point at this entry pick up the rename. The local entries
        // array may not contain this entry (different journal scope), so
        // mergeEntries is used instead of updateEntry to avoid relying
        // on the array having a matching row.
        useEntryStore.getState().mergeEntries([fetched])
      })
    }
    const onPatched = (e: Event) => {
      const detail = (e as CustomEvent<EntryPatchDetail>).detail
      if (!detail || detail.id !== entryId) return
      setEntry((prev) => (prev ? { ...prev, ...detail.patch } : prev))
    }
    window.addEventListener('memlore:entries-changed', handler)
    window.addEventListener('memlore:entry-patched', onPatched)
    return () => {
      window.removeEventListener('memlore:entries-changed', handler)
      window.removeEventListener('memlore:entry-patched', onPatched)
    }
  }, [entryId, activeVaultId])

  // Called by Editor on every content update — schedules debounced auto-save
  // AND publishes a live word/char count so the FooterBar updates on every
  // keystroke instead of only after the 1500ms save debounce.
  const handleEditorUpdate = useCallback(() => {
    if (!docRef.current || !entryIdRef.current) return

    // Live metrics — Y.Doc is authoritative while the debounce is pending.
    const text = extractPlainText(docRef.current)

    // The Collaboration extension fires onUpdate once on initial sync to bring
    // ProseMirror in line with the Y.Doc. That event produces exactly the same
    // state that was just loaded, so we can safely skip it. We compare both
    // plain text AND Yjs state vector so that media-only changes (image paste,
    // which adds no text) are also detected and persisted.
    const currentYjsState = Y.encodeStateVector(docRef.current)
    const lastState = lastPersistedYjsStateRef.current
    const yjsUnchanged =
      lastState !== null &&
      lastState.length === currentYjsState.length &&
      lastState.every((b, i) => b === currentYjsState[i])
    if (text === lastPersistedTextRef.current && yjsUnchanged) return

    // Version history (Phase 3): session-based snapshot. This point is a
    // real user content change (the initial Yjs-bind event was already
    // filtered out above), so it's the correct place to detect a new
    // session and capture the pre-edit baseline exactly once per session.
    const now = Date.now()
    if (sessionSnapshotTakenRef.current && now - lastEditAtRef.current > SESSION_IDLE_MS) {
      // Idle gap exceeded — this burst starts a new session, eligible for
      // its own snapshot. baselineBytesRef already holds the last-saved
      // state (updated after every autosave), so it correctly reflects
      // "state at the start of this burst," not the stale entry-load state.
      sessionSnapshotTakenRef.current = false
    }
    if (
      !sessionSnapshotTakenRef.current &&
      baselineBytesRef.current &&
      baselineBytesRef.current.length > 0
    ) {
      const snapshotEntryId = entryIdRef.current
      const yjsDoc = Array.from(baselineBytesRef.current)
      const previewText = baselinePreviewRef.current
      // Set the guard synchronously (before the IPC round-trip resolves) so
      // rapid keystrokes within the same burst can't fire a second snapshot
      // while the first request is still in flight.
      sessionSnapshotTakenRef.current = true
      snapshotEntryVersion(snapshotEntryId, yjsDoc, previewText)
        .then(() => emitEntryVersionsChanged(snapshotEntryId))
        .catch((err: unknown) => {
          // Best-effort: a missed session-snapshot doesn't corrupt anything,
          // it just means one fewer history checkpoint for this session.
          console.error('[EditorPanel] session snapshot failed:', err)
        })
    }
    lastEditAtRef.current = now

    const words = text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length
    useEditorMetricsStore.getState().setMetrics(entryIdRef.current, words, text.length)

    setSaveStatus('unsaved')
    if (autoSaveTimer.current) {
      clearTimeout(autoSaveTimer.current)
    }
    autoSaveTimer.current = setTimeout(() => {
      if (docRef.current && entryIdRef.current) {
        triggerAutoSave(docRef.current, entryIdRef.current)
      }
    }, AUTO_SAVE_DEBOUNCE_MS)
  }, [triggerAutoSave])

  // Save title changes via updateEntry
  const handleTitleSave = useCallback(
    async (newTitle: string) => {
      if (!entry) return
      try {
        const updated = await updateEntry(entry.id, newTitle, undefined, undefined)
        setEntry(updated)
        useEntryStore.getState().updateEntry(updated)
        setSavedTitle(newTitle)
        setSaveError(null)
        // In-place patch instead of full invalidate — same reasoning as
        // the auto-save path: title editing should not flash the list to
        // a Loading placeholder on every debounced save tick.
        emitEntryPatched(entry.id, { title: updated.title })
      } catch (err: unknown) {
        setSaveError(err instanceof Error ? err.message : 'Save failed')
      }
    },
    [entry],
  )

  // Debounced title save
  const titleSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const titleInputRef = useRef<HTMLTextAreaElement | null>(null)

  // Auto-grow the title textarea so wrapped lines stay visible without
  // an internal scrollbar. Reset to `auto` first so shrinking also works.
  const resizeTitle = useCallback(() => {
    const el = titleInputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [])

  useEffect(() => {
    resizeTitle()
  }, [title, resizeTitle])

  const handleTitleChange = useCallback(
    (newTitle: string) => {
      setTitle(newTitle)
      setSaveError(null)
      setSaveStatus('unsaved')
      if (titleSaveTimer.current) clearTimeout(titleSaveTimer.current)
      titleSaveTimer.current = setTimeout(() => {
        handleTitleSave(newTitle)
      }, AUTO_SAVE_DEBOUNCE_MS)
    },
    [handleTitleSave],
  )

  // Handle emotion selection from the picker — `emotion` is one of
  // 'good' | 'neutral' | 'bad' | null after the 2026-05 refactor.
  const handleEmotionSelect = useCallback(
    async (emotion: EmotionKey | null) => {
      if (!entry) return
      try {
        const updated = await updateEntryEmotion(entry.id, emotion)
        setEntry(updated)
        useEntryStore.getState().updateEntry(updated)
        emitEntryPatched(updated.id, { emotion: updated.emotion })
        setSaveError(null)
      } catch (err: unknown) {
        setSaveError(err instanceof Error ? err.message : 'Failed to save mood')
      }
    },
    [entry],
  )

  // Handle location selection from the picker
  const handleLocationSelect = useCallback(
    async (
      lat: number | null,
      lng: number | null,
      label: string | null,
      address: string | null,
    ) => {
      if (!entry) return
      try {
        const updated = await updateEntryLocation(entry.id, lat, lng, label, address)
        setEntry(updated)
        useEntryStore.getState().updateEntry(updated)
        emitEntryPatched(updated.id, {
          latitude: updated.latitude,
          longitude: updated.longitude,
          location_label: updated.location_label,
          location_address: updated.location_address,
        })
        setSaveError(null)

        // Auto-fetch weather for the entry date when coordinates change.
        const coordsChanged = lat !== entry.latitude || lng !== entry.longitude
        if (lat !== null && lng !== null && coordsChanged) {
          const weatherUpdated = await applyEntryWeather(updated.id, lat, lng, entry.entry_date)
          if (weatherUpdated) {
            setEntry(weatherUpdated)
            useEntryStore.getState().updateEntry(weatherUpdated)
            emitEntryPatched(weatherUpdated.id, {
              weather_summary: weatherUpdated.weather_summary,
              weather_icon: weatherUpdated.weather_icon,
            })
          }
        }
      } catch (err: unknown) {
        setSaveError(err instanceof Error ? err.message : 'Failed to save location')
      }
    },
    [entry],
  )

  const handleToggleFavorite = useCallback(async () => {
    if (!entry) return
    try {
      const isFavorite = await toggleFavorite(entry.id)
      const updated = { ...entry, is_favorite: isFavorite }
      setEntry(updated)
      useEntryStore.getState().updateEntry(updated)
      setSaveError(null)
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'Failed to toggle favorite')
    }
  }, [entry])

  const handleRefetchWeather = useCallback(async () => {
    if (!entry || entry.latitude == null || entry.longitude == null) return
    const updated = await applyEntryWeather(
      entry.id,
      entry.latitude,
      entry.longitude,
      entry.entry_date,
    )
    if (updated) {
      setEntry(updated)
      useEntryStore.getState().updateEntry(updated)
    }
  }, [entry])

  const handleApplyTemplate = useCallback(
    (template: Template) => {
      if (!entry) return
      handleTitleChange(template.name)
    },
    [entry, handleTitleChange],
  )

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current)
      if (titleSaveTimer.current) clearTimeout(titleSaveTimer.current)
    }
  }, [])

  // Detect media rows that exist in the DB but are absent from the Yjs doc
  // (save-bug orphans). Intentional cross-device deletion writes a media
  // tombstone; once a peer honours it the row is gone, so this banner has
  // nothing to recover. Only rows-without-doc-reference remain orphans.
  useEffect(() => {
    if (!doc || !entryId) {
      return
    }
    let cancelled = false
    // Only inline media can be "orphaned" — attached media live in the
    // footer strip and are never embedded in the Yjs doc by design.
    listMediaForEntry(entryId, 'inline', activeVaultId)
      .then((inlineMedia) => {
        if (cancelled || inlineMedia.length === 0) return
        const docMediaIds = extractMediaIdsFromYDoc(doc)
        const orphans = inlineMedia.filter((r) => !docMediaIds.has(r.id))
        if (!cancelled) setOrphanedMedia(orphans)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [doc, entryId, activeVaultId])

  const handleRecoverMedia = useCallback(() => {
    const editor = editorRef.current
    if (!editor || orphanedMedia.length === 0) return
    editor.chain().focus('end').run()
    for (const row of orphanedMedia) {
      const src = convertFileSrc(row.storage_path)
      const nodeType = row.file_type.startsWith('video/')
        ? 'video'
        : row.file_type.startsWith('audio/')
          ? 'audio'
          : 'image'
      editor.commands.insertContent({
        type: nodeType,
        attrs: { src, 'data-media-id': row.id },
      })
    }
    setOrphanedMedia([])
    // Recovery only re-inserts existing media rows — cover_media_id was
    // already set (or not) when those rows were originally created — so
    // we do NOT need to call handleCoverMaybeChanged here.
  }, [orphanedMedia])

  const handleEditorReady = useCallback((editor: TipTapEditor) => {
    editorRef.current = editor
    // Version history (Phase 3): a restore may have been requested while
    // this entry wasn't the active editor (or before its editor instance
    // existed for this doc). Now that a live editor exists, apply it if
    // it's still pending for this entry.
    attemptPendingRestoreRef.current?.()
  }, [])

  // Version history (Phase 3): apply a pending CRDT-safe restore once this
  // entry's live editor is ready. Never mutates the `yjs_doc` blob directly —
  // it fetches the version content, converts it to TipTap JSON, and applies
  // it via `setContent(json, { emitUpdate: true })` so Yjs records the
  // change as delete+insert ops, which is what makes the restore merge
  // correctly (rather than clobber) on other devices.
  //
  // This function is the sole owner of clearing the pending-restore
  // singleton (`setPendingRestore(null)`):
  //  - match (pending.entryId === the currently-loaded entry) → apply, then
  //    clear (clear-on-consume).
  //  - mismatch → clear too (abandon). The user navigated away from the
  //    restore target, so leaving it set would silently apply a stale
  //    restore later if they happen to return to that entry.
  //  - no pending → no-op.
  const attemptPendingRestore = useCallback(() => {
    const pending = getPendingRestore()
    if (!pending) return
    if (pending.entryId !== entryIdRef.current) {
      setPendingRestore(null)
      return
    }
    const editor = editorRef.current
    if (!editor) return
    setPendingRestore(null)

    // Fix: a session may have already taken its one-per-session snapshot
    // (sessionSnapshotTakenRef already true), in which case any edits made
    // since that snapshot would otherwise never be persisted anywhere —
    // contradicting the confirm dialog's promise that "the current content
    // is kept in history." Capture the CURRENT (pre-restore) doc as its own
    // version here, synchronously, before the async fetch below resolves
    // and mutates the doc via setContent. The snapshot IPC call itself is
    // fire-and-forget (best-effort), same as the session-snapshot above.
    const restoreEntryId = entryIdRef.current
    const currentDoc = docRef.current
    if (currentDoc && restoreEntryId) {
      const currentDocBytes = serializeYDoc(currentDoc)
      const currentPreview = extractPlainText(currentDoc).slice(0, 150)
      if (currentDocBytes.length > 0 && currentPreview.length > 0) {
        const currentBytes = Array.from(currentDocBytes)
        snapshotEntryVersion(restoreEntryId, currentBytes, currentPreview)
          .then(() => emitEntryVersionsChanged(restoreEntryId))
          .catch((err: unknown) => {
            console.error('[EditorPanel] pre-restore snapshot failed:', err)
          })
        // Prevents handleEditorUpdate from taking a near-duplicate snapshot
        // of the same pre-restore content once setContent below fires its
        // own update event.
        sessionSnapshotTakenRef.current = true
      }
    }

    getEntryVersionContent(
      pending.versionId,
      pending.entryId,
      useInvisibleLockStore.getState().activeVaultId,
    )
      .then((bytes) => {
        const json = snapshotToPmJson(new Uint8Array(bytes))
        editor.commands.setContent(json, { emitUpdate: true })
      })
      .catch((err: unknown) => {
        console.error('[EditorPanel] Failed to restore version:', err)
        toast(t('versionHistory.restore_failed'))
      })
  }, [t])

  // Keep the forward-declared ref in sync so `handleEditorReady` and the
  // restore-event listener (registered once, below) can call the latest
  // `attemptPendingRestore` without needing to re-subscribe.
  useEffect(() => {
    attemptPendingRestoreRef.current = attemptPendingRestore
  }, [attemptPendingRestore])

  // Version history (Phase 3): listen for restore requests dispatched by
  // the (future) version-history UI. If the target entry isn't already the
  // active editor, repoint the active tab at it — mirrors every other
  // "open this entry" call site in the app (EntryList, SearchOverlay, etc.),
  // none of which search for/reuse an existing tab showing the same entry.
  useEffect(() => {
    const handler = (e: Event) => {
      // More than one EditorPanel can be mounted (main panel + the map
      // overlay in LocationsMapView) and both register this listener. The
      // restore target may not be focused (or even open) yet, so — unlike
      // the ⌘F handler's `editorRef.current?.isFocused` check — focus isn't
      // the right discriminator here. Instead, only the most recently
      // mounted instance (i.e. the one for the current view) handles it.
      if (!isActiveEditorInstance(editorInstanceIdRef.current)) return
      const detail = (e as CustomEvent<RestoreEntryVersionDetail>).detail
      if (!detail) return
      setPendingRestore({ entryId: detail.entryId, versionId: detail.versionId })
      if (entryIdRef.current !== detail.entryId) {
        useTabStore.getState().updateActiveTab({
          selectedEntryId: detail.entryId,
          activeView: 'entries',
        })
        // The tab switch triggers an entry-load effect — either on THIS
        // instance (main panel showing a different entry) or, if this was
        // the map overlay, it unmounts this instance and mounts a fresh
        // main EditorPanel. Either way, the pending-restore singleton
        // survives (it isn't tied to this instance), and whichever
        // instance's `handleEditorReady` next fires for the target entry
        // will pick it up via `attemptPendingRestore`.
        return
      }
      attemptPendingRestoreRef.current?.()
    }
    window.addEventListener('memlore:restore-entry-version', handler as EventListener)
    return () =>
      window.removeEventListener('memlore:restore-entry-version', handler as EventListener)
  }, [])

  const handleCloseFind = useCallback(() => {
    editorRef.current?.commands.clearFind()
    setFindOpen(false)
    editorRef.current?.commands.focus()
  }, [])

  // Refetch the entry whenever an image OR video was inserted or removed
  // (inline OR attached). Inserting either can set `cover_media_id`
  // server-side via `set_cover_if_unset_for_image_or_video` (only when
  // no cover is set yet — videos become covers via their extracted
  // poster JPEG); deletion can clear it via the
  // `clear_entry_cover_on_media_delete` trigger. Re-pulling the entry
  // keeps the EntryCard cover on the left panel in sync without
  // reaching into server state from the editor side.
  // Declared BEFORE `handleGeneratedImage` so the latter can list it in
  // its deps without hitting a temporal-dead-zone error.
  const handleCoverMaybeChanged = useCallback(async () => {
    const id = entryIdRef.current
    if (!id) return
    try {
      const updated = await getEntry(id, activeVaultId)
      if (!updated) return
      setEntry(updated)
      useEntryStore.getState().updateEntry(updated)
      // In-place patch the paginated `useEntries` instances on the left
      // panel — emitting a full `memlore:entries-changed` here would
      // flash the entry list to its "Loading" placeholder on every
      // photo insert / cover update (the exact UX bug fixed in
      // commit 1328608). The cover_media_id is the only field that
      // moves through this path; everything else is unchanged.
      emitEntryPatched(id, {
        cover_media_id: updated.cover_media_id,
        media_count: updated.media_count,
        // Title and preview may have been adjusted server-side via the
        // EXIF-driven flows (cover auto-set); patch them too so the
        // card never disagrees with the just-fetched entry.
        title: updated.title,
        preview_text: updated.preview_text,
        entry_date: updated.entry_date,
        latitude: updated.latitude,
        longitude: updated.longitude,
        entry_date_user_edited: updated.entry_date_user_edited,
      })
    } catch {
      // Best-effort refresh — failure just means the card stays stale
      // until the next entry-list reload.
    }
  }, [activeVaultId])

  // Phase 6 v2 R10 — place a generated image. Inline mode inserts a
  // TipTap `image` node at the caret (same shape as paste / pick-image
  // so MediaNodeView → MediaAttachment handles it). Attached mode only
  // refreshes cover metadata — the attachment strip is refetched by the
  // Editor wrapper when `insertionMode === 'attached'`.
  const handleGeneratedImage = useCallback(
    (result: GenerateImageResult) => {
      if (result.insertionMode === 'inline') {
        const editor = editorRef.current
        if (!editor) return
        editor
          .chain()
          .focus()
          .insertContent({
            type: 'image',
            attrs: {
              src: convertFileSrc(result.localPath),
              'data-media-id': result.mediaId,
            },
          })
          .run()
      }
      void handleCoverMaybeChanged()
    },
    [handleCoverMaybeChanged],
  )

  // Phase 6 v2 R8 — insert a Go-Deeper prompt as an H3 followed by an
  // empty paragraph at end-of-document, so the cursor lands on a
  // fresh writable line below the heading. Reads the live editor
  // handle through the existing ref (set in `handleEditorReady`) so
  // the popover doesn't have to track editor-ready state.
  const handleGoDeeperUsePrompt = useCallback((prompt: string) => {
    const editor = editorRef.current
    if (!editor) return
    editor
      .chain()
      .focus('end')
      .insertContent([
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: prompt }] },
        { type: 'paragraph' },
      ])
      .run()
  }, [])

  // Flush the pending auto-save immediately (used after media deletion so the
  // Yjs doc is persisted before the user switches entries).
  const handleImmediateSave = useCallback(() => {
    if (!docRef.current || !entryIdRef.current) return
    if (autoSaveTimer.current) {
      clearTimeout(autoSaveTimer.current)
      autoSaveTimer.current = null
    }
    triggerAutoSave(docRef.current, entryIdRef.current)
  }, [triggerAutoSave])

  // ── Render states ──────────────────────────────────────────────────────────

  if (!entryId) {
    return (
      <div className="text-fg-muted flex h-full items-center justify-center">
        <div className="flex flex-col items-center text-center">
          <span className="text-fg-muted mb-3 opacity-70">
            <PenLine className="size-8" strokeWidth={1.75} />
          </span>
          <p className="text-sm">{t('panel.no_selection')}</p>
        </div>
      </div>
    )
  }

  if (notFound) {
    return (
      <div className="text-fg-muted flex h-full items-center justify-center">
        <p>{t('panel.not_found')}</p>
      </div>
    )
  }

  if (!entry || !doc || !mathHydrated || !emojiHydrated || (needsMath && !mathReady)) {
    return (
      <div className="text-fg-muted flex h-full items-center justify-center">
        {mathLoadFailed ? (
          <p className="text-sm">{t('panel.math_load_failed')}</p>
        ) : (
          <p className="text-sm">{t('panel.loading')}</p>
        )}
      </div>
    )
  }

  // Layout: EditorHeader (metadata pills) stays fixed; titleSlot pins the
  // entry title above the scrollable ProseMirror canvas (640px column).
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {/* Find-in-editor bar — overlays the editor top-right. Controlled by
          `findOpen`; Task 3 will wire the ⌘F event listener to open it. */}
      {findOpen && (
        <EditorFindBar
          editor={editorRef.current}
          onClose={handleCloseFind}
          refocusTick={findFocusTick}
        />
      )}

      {/* Toolbar, pinned title, and scrollable body are owned by <Editor/>.
          Title renders via `titleSlot` so only the entry body scrolls. */}
      <Editor
        doc={doc}
        mathExtensions={mathExtensions}
        editable={true}
        onUpdate={handleEditorUpdate}
        onApplyTemplate={handleApplyTemplate}
        initialTemplate={pendingTemplate}
        initialChatDraftHtml={pendingChatDraftHtml}
        initialChatAppendHtml={appendToApply}
        entryId={entryId}
        entry={entry}
        journal={journal}
        onEditorReady={handleEditorReady}
        onImmediateSave={handleImmediateSave}
        onCoverMaybeChanged={handleCoverMaybeChanged}
        titleSlot={
          <>
            {chatSource && (
              <ChatBackRefBanner
                sessionId={chatSource.sessionId}
                title={chatSource.title}
                onOpen={(sid) =>
                  updateActiveTab({
                    activeView: 'chat',
                    selectedChatSessionId: sid,
                    selectedChatSessionIsDraft: false,
                  })
                }
              />
            )}
            {orphanedMedia.length > 0 && (
              <Callout
                tone="warning"
                className="mb-4"
                action={
                  <button
                    type="button"
                    onClick={handleRecoverMedia}
                    className="border-warning-border text-warning-fg hover:bg-warning-border shrink-0 rounded-md border bg-transparent px-3 py-1 text-sm font-medium"
                  >
                    Recover
                  </button>
                }
              >
                {orphanedMedia.length} media file{orphanedMedia.length > 1 ? 's' : ''} attached to
                this entry {orphanedMedia.length > 1 ? 'are' : 'is'} not visible in the editor.
              </Callout>
            )}
            {/* Title row — the Suggest-title affordance lives flush right
                of the title input. It self-gates on toggle, empty title,
                and ≥200-char body, so the icon only appears when the
                action is meaningful. Generate Image lives in the editor
                footer as an icon-only control (same row as Highlights). */}
            <div className="mb-4 flex items-start gap-2">
              <textarea
                ref={titleInputRef}
                value={title}
                onChange={(e) => handleTitleChange(e.target.value)}
                onKeyDown={(e) => {
                  // Title is a single logical field — Enter should move focus
                  // into the editor body, not insert a newline.
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    editorRef.current?.commands.focus()
                  }
                }}
                placeholder={t('panel.title_placeholder')}
                rows={1}
                dir={rightToLeftEnabled ? 'rtl' : 'ltr'}
                // Entry titles use the editorial serif (Fraunces) regardless of
                // the editor body font picker — see --font-title in globals.css.
                style={{ fontFamily: 'var(--font-title)' }}
                className="xj-entry-title text-fg block flex-1 resize-none overflow-hidden border-none bg-transparent py-1 text-3xl leading-tight font-bold tracking-tight wrap-break-word outline-none"
              />
              <div className="shrink-0 pt-2">
                <SuggestTitlePill
                  entryId={entry?.id ?? null}
                  bodyCharCount={entryCharCount}
                  currentTitle={title}
                  onTitleSuggested={handleTitleChange}
                />
              </div>
            </div>
          </>
        }
        onEmotionPickerOpen={() => setShowEmotionPicker((v) => !v)}
        onLocationSelect={handleLocationSelect}
        onRefetchWeather={handleRefetchWeather}
        onToggleFavorite={handleToggleFavorite}
        highlightsEnabled={aiEntryHighlightsEnabled === true}
        goDeeperEnabled={aiGoDeeperEnabled === true}
        wordCount={entryWordCount}
        onGeneratedImage={handleGeneratedImage}
        renderHighlightsPopover={(close) =>
          entry ? (
            <EntryHighlightsPopover
              state={highlights.state}
              generate={highlights.generate}
              cancel={highlights.cancel}
              clear={highlights.clear}
              onClose={close}
            />
          ) : null
        }
        renderGoDeeperPopover={(close) =>
          entry ? (
            <GoDeeperPopover
              entryId={entry.id}
              state={goDeeper.state}
              generate={goDeeper.generate}
              dismiss={goDeeper.dismiss}
              onUsePrompt={handleGoDeeperUsePrompt}
              onClose={close}
            />
          ) : null
        }
        proseVoiceDisabledReason={proseVoiceDisabledReason}
        onRewriteSelection={
          // Same toggle as the footer's continue button — one feature, both
          // editor-prose actions. `null` (still hydrating) hides the bubble
          // menu's Rewrite row rather than flashing it in.
          aiContinueWritingEnabled === true
            ? (selectedText) => {
                if (!entry) return Promise.reject(new Error('entry unavailable'))
                return editorProseVoice.rewrite(entry.id, selectedText)
              }
            : undefined
        }
        onContinueWriting={
          // `null` (still hydrating) keeps the button hidden rather than
          // flashing it in — same contract as the Go Deeper gate above.
          aiContinueWritingEnabled === true
            ? (context) => {
                if (!entry) return Promise.reject(new Error('entry unavailable'))
                return editorProseVoice.continueWriting(entry.id, context)
              }
            : undefined
        }
      />

      {showEmotionPicker && (
        <EmotionPicker
          onSelect={handleEmotionSelect}
          onClose={() => setShowEmotionPicker(false)}
          currentEmotion={entry.emotion}
          entryId={entry.id}
          entryWordCount={entryWordCount}
        />
      )}

      {/* Save error message — rendered only on error, aligned with the
          editor's centered 640px reading column so it never drifts into the
          gutter on wide viewports. Save status (Saving/Saved/…) lives in the
          global <FooterBar/> (Chunk D); duplicating it here would give the
          editor two save indicators. */}
      {saveError && (
        <div className={editorContentColumnClass(distractionMode, 'px-12 pb-3')}>
          <span className="text-danger-text text-xs">{saveError}</span>
        </div>
      )}

      {/* Phase 6 v2 R7/R8 — Highlights + Go-Deeper live in the editor
          footer AI menu, with their popovers rendered via render-props.
          Stream / cached state lives on the lifted `useEntryHighlights`
          and `useGoDeeper` hooks above, so the stream survives popover
          open/close. */}
    </div>
  )
}
