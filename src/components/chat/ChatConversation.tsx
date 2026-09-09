import {
  ArrowUpRight,
  Brain,
  CalendarRange,
  Check,
  Copy,
  FileText,
  MessageCircleMore,
  MessageSquare,
  Sparkle,
  Paperclip,
  SendHorizontal,
  Square,
} from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingPortal,
  offset,
  shift,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react'
import { useTranslation } from 'react-i18next'
import { useUpdateActiveTab } from '../../hooks/useActiveTab'
import { useChatContextPreflight } from '../../hooks/useChatContextPreflight'
import { useChatRagEnabled } from '../../hooks/useChatRagEnabled'
import type { ChatMessage } from '../../hooks/useDailyChat'
import { useDailyChat } from '../../hooks/useDailyChat'
import { useEntryTitles } from '../../hooks/useEntryTitles'
import { type MemoryTextLookup, useMemoryTexts } from '../../hooks/useMemoryTexts'
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion'
import { useShowMessageMeta } from '../../hooks/useShowMessageMeta'
import { resolveChatSendPayload } from '../../lib/chatSendDecision'
import { isDailyChatActionEnabled, type DailyChatReady } from '../../hooks/useAiDailyChatReady'
import { cn } from '../../lib/cn'
import { formatDateRange, formatEntryDate, formatFriendlyRelativeTime } from '../../lib/dates'
import { escapeHtmlText, markdownToHtml } from '../../lib/markdownToHtml'
import {
  resolveTranscriptScrollMode,
  scrollTranscriptToBottom,
} from '../../lib/scrollTranscriptToBottom'
import { renderSimpleMarkdown } from '../../lib/simpleMarkdown'
import { splitTitleAndBody } from '../../lib/splitTitleAndBody'
import { createEntry, getEntry } from '../../lib/tauri'
import { toast } from '../../lib/toast'
import {
  mergeConsumedEntryChip,
  useChatComposerAttachmentsStore,
} from '../../stores/chatComposerAttachmentsStore'
import { useChatComposerDraftStore } from '../../stores/chatComposerDraftStore'
import { useChatDraftStore } from '../../stores/chatDraftStore'
import { announce } from '../../stores/announcerStore'
import { useChatPendingAttachmentsStore } from '../../stores/chatPendingAttachmentsStore'
import type { ChatAttachment, ChatAttachmentRef, ChatContextRefusal } from '../../types/ai'
import { MessageInfoPopover } from '../ai/MessageInfoPopover'
import { Button } from '../common/Button'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { ShimmerText } from '../common/ShimmerText'
import { InlineOrb } from '../common/ThinkingOrb'
import { Tooltip } from '../common/Tooltip'
import { ChatAttachPopover } from './ChatAttachPopover'
import { ChatAttachmentBar } from './ChatAttachmentBar'
import { ChatContextConfirmDialog } from './ChatContextConfirmDialog'
import { ChatRagToggle } from './ChatRagToggle'
import { ChatSourceChips } from './ChatSourceChips'
import { ConvertToEntryDialog } from './ConvertToEntryDialog'
import { EntryPreviewModal } from './EntryPreviewModal'
import { EntryRefBadge } from './EntryRefBadge'
import { resolveEntryButtonState } from './chatEntryButton'

type TFn = ReturnType<typeof useTranslation<['ai', 'editor']>>['t']

function toAttachmentRef(a: ChatAttachment): ChatAttachmentRef {
  return a.kind === 'entry'
    ? { kind: 'entry', id: a.id }
    : { kind: 'period', start: a.start, end: a.end, label: a.label }
}

/** Whether an assistant reply has journal sources to show behind the
 *  paperclip trigger — mirrors the guard the inline chips used to apply. */
function hasSources(m: ChatMessage): boolean {
  return m.role === 'assistant' && (m.sourceEntryIds?.length ?? 0) > 0
}

/** Whether an assistant reply has memory ids to resolve behind the memories
 *  chip trigger. The chip itself may still render nothing if
 *  every id turns out to be deleted once resolved (see `MemoriesUsedChip`). */
function hasMemories(m: ChatMessage): boolean {
  return m.role === 'assistant' && (m.memoryIds?.length ?? 0) > 0
}

/** Which refusal codes `ChatAttachmentBar` should show inline. `needs_confirmation`
 *  is handled solely by `ChatContextConfirmDialog` — showing it in both places
 *  would duplicate the same numbers in two competing UI surfaces. */
function inlineRefusal(
  refusal: ChatContextRefusal | null,
): Exclude<ChatContextRefusal, { code: 'needs_confirmation' }> | null {
  if (!refusal) return null
  switch (refusal.code) {
    case 'period_too_large':
    case 'period_no_budget':
    case 'consent_required':
      return refusal
    case 'needs_confirmation':
      return null
  }
}

/** Read-only attachment chips rendered above a persisted user message —
 *  what the model actually saw for that turn, so a months-old transcript
 *  still shows it. Unlike `ChatAttachmentBar`'s chips, these have no
 *  remove button and carry only what `ChatAttachmentRef` persists on the
 *  wire (no title/entry-count metadata), so entry titles are resolved
 *  here via `useEntryTitles` and period labels re-derived from `start`/`end`
 *  the same way `ChatAttachmentBar` does. */
function MessageAttachmentChips({
  attachments,
  locale,
  t,
}: {
  attachments: ChatAttachmentRef[]
  locale: string
  t: TFn
}) {
  const entryIds = attachments.filter((a) => a.kind === 'entry').map((a) => a.id)
  const { titles } = useEntryTitles(entryIds)

  return (
    <div className="mb-1 flex w-full flex-wrap justify-end gap-1.5">
      {attachments.map((a, index) => {
        if (a.kind === 'entry') {
          const title = titles.get(a.id) ?? t('editor:untitled_entry', { defaultValue: 'Untitled' })
          return (
            <span
              key={index}
              className="border-border-default bg-panel-2 text-fg-secondary text-2xs inline-flex max-w-50 items-center gap-1.5 rounded-full border py-1 pr-2.5 pl-2.5 font-medium"
            >
              <FileText className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{title}</span>
            </span>
          )
        }
        const label = formatDateRange(a.start, a.end, locale) || a.label
        return (
          <span
            key={index}
            className="border-border-default bg-panel-2 text-fg-secondary text-2xs inline-flex max-w-50 items-center gap-1.5 rounded-full border py-1 pr-2.5 pl-2.5 font-medium"
          >
            <CalendarRange className="size-3 shrink-0" aria-hidden />
            <span className="truncate">{label}</span>
          </span>
        )
      })}
    </div>
  )
}

/** Copy button rendered in an assistant reply's meta row — copies the
 *  raw reply text (`m.content`) to the clipboard. Shows a transient
 *  checkmark for ~1.5s, then reverts to the copy icon. No-op if the
 *  clipboard API rejects (sandboxed / unavailable). */
function MessageCopyButton({ content, t }: { content: string; t: TFn }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(id)
  }, [copied])
  return (
    <Tooltip
      content={
        copied
          ? t('daily_chat.copied', { defaultValue: 'Copied' })
          : t('daily_chat.copy', { defaultValue: 'Copy' })
      }
    >
      <Button
        variant="ghost"
        size="sm"
        className="text-fg-muted hover:text-fg size-6 justify-center p-0"
        aria-label={t('daily_chat.copy', { defaultValue: 'Copy' })}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(content)
            setCopied(true)
          } catch {
            /* clipboard unavailable — silently no-op */
          }
        }}
      >
        {copied ? (
          <Check className="size-3.5" aria-hidden />
        ) : (
          <Copy className="size-3.5" aria-hidden />
        )}
      </Button>
    </Tooltip>
  )
}

const knownErrorCodes: Record<string, string> = {
  AI_AUTH_FAILED: 'error.AI_AUTH_FAILED',
  AI_RATE_LIMITED: 'error.AI_RATE_LIMITED',
  AI_NOT_CONFIGURED: 'error.AI_NOT_CONFIGURED',
  AI_PRIVACY_NOT_ACCEPTED: 'error.AI_PRIVACY_NOT_ACCEPTED',
  AI_DAILY_CHAT_DISABLED: 'error.AI_DAILY_CHAT_DISABLED',
}

interface ChatConversationProps {
  /** When null, the empty state is rendered instead of a conversation. */
  sessionId: string | null
  /** AI readiness on this device — gates Send (and Enter-to-send). */
  ready?: DailyChatReady | null
  /** Called after a successful "Save as entry" flow so the parent can
   *  optionally drop the session or refresh state. */
  onSavedAsEntry?: () => void
}

/**
 * Right-pane conversation view (extracted from `DailyChatView`).
 *
 * Owns the active session's `useDailyChat` hook, the input box, and
 * the convert-to-entry dialog. The session selection itself lives in
 * `DailyChatView`.
 */
export function ChatConversation({
  sessionId,
  ready = null,
  onSavedAsEntry,
}: ChatConversationProps) {
  const { t, i18n } = useTranslation(['ai', 'editor'])
  const {
    messages,
    turn,
    refusal,
    sendMessage,
    cancelTurn,
    convertedEntryId,
    newSinceConversion,
    convertDelta,
    markConverted,
    convertToEntry,
  } = useDailyChat(sessionId)
  const wasStreaming = useRef(false)
  const streamedMessageId = useRef<string | null>(null)
  useEffect(() => {
    if (turn.kind === 'streaming') {
      streamedMessageId.current = turn.messageId
      if (!wasStreaming.current) announce(t('announcer.generating'))
    } else if (wasStreaming.current) {
      const id = streamedMessageId.current
      const msg = id ? messages.find((m) => m.id === id) : undefined
      if (msg && !msg.streaming && !msg.errorCode && msg.content) {
        announce(t('announcer.reply_ready'))
      }
      streamedMessageId.current = null
    }
    wasStreaming.current = turn.kind === 'streaming'
  }, [turn, messages, t])
  const { showMessageMeta } = useShowMessageMeta()
  const updateActiveTab = useUpdateActiveTab()
  const { enabled: ragEnabled } = useChatRagEnabled()
  // One shared `useMemoryTexts` call for the whole transcript instead of one
  // per `MemoriesUsedChip` — each chip used to run its own full
  // `listMemoryItems()` fetch, so a transcript with N assistant turns that
  // used memory made N identical full-table IPC calls (review suggestion).
  const allMemoryIds = useMemo(
    () => messages.flatMap((m) => (m.role === 'assistant' ? (m.memoryIds ?? []) : [])),
    [messages],
  )
  const memoryTexts = useMemoryTexts(allMemoryIds)

  const [input, setInput] = useState(() =>
    sessionId ? useChatComposerDraftStore.getState().getDraft(sessionId) : '',
  )
  // null = closed; 'save' = first conversion (full chat → new entry);
  // 'update' = append delta to `convertedEntryId`. Drives which loadDraft
  // and which save handler run while the dialog is mounted.
  const [convertMode, setConvertMode] = useState<'save' | 'update' | null>(null)
  const [showConvertDialog, setShowConvertDialog] = useState(false)
  // Open when an "Update the entry" target turns out to be deleted / locked
  // / invisible — offers to save the new messages as a fresh entry instead.
  const [blockDialogOpen, setBlockDialogOpen] = useState(false)
  const [attachments, setAttachmentsState] = useState<ChatAttachment[]>(() =>
    sessionId ? useChatComposerAttachmentsStore.getState().getAttachments(sessionId) : [],
  )
  const setAttachments = useCallback(
    (update: ChatAttachment[] | ((prev: ChatAttachment[]) => ChatAttachment[])) => {
      setAttachmentsState((prev) => {
        const next = typeof update === 'function' ? update(prev) : update
        if (sessionId) {
          useChatComposerAttachmentsStore.getState().setAttachments(sessionId, next)
        }
        return next
      })
    },
    [sessionId],
  )
  const [attachPopoverOpen, setAttachPopoverOpen] = useState(false)
  /** Entry shown in the read-only preview modal, opened from a source chip
   *  or an inline entry badge. `null` = closed. */
  const [previewEntryId, setPreviewEntryId] = useState<string | null>(null)
  // Which `needs_confirmation` refusal the user already dismissed via
  // Cancel — compared by reference against the hook's `refusal` below so
  // the dialog derives cleanly from render state instead of needing an
  // effect to sync a copy of it. A fresh refusal (new object) always
  // reopens the dialog; confirming resets `refusal` to `null` via the
  // hook's next `send` dispatch, which also makes this comparison moot.
  const [dismissedRefusal, setDismissedRefusal] = useState<ChatContextRefusal | null>(null)
  const attachButtonRef = useRef<HTMLButtonElement>(null)
  const attachPopoverId = useId()
  // The exact turn a refused send attempted — replayed verbatim with
  // `oversizeConfirmed: true` when the user confirms the size dialog.
  const pendingSendRef = useRef<{ text: string; attachments: ChatAttachmentRef[] } | null>(null)
  // Carries the `throughSeq` returned by `convertToEntry` / `convertDelta`
  // out of the loadDraft closure (which the dialog drives) into the save
  // handler (which runs later, when the user clicks Save). `null` only
  // between a reset and the next loadDraft — by save time it always holds
  // the watermark the backend just reported for this draft.
  const stashedThroughSeq = useRef<number | null>(null)
  // Holds the delta markdown (and the blocked target's journal id) from a
  // blocked update attempt while the block dialog is open, so "Save as new
  // entry" can re-file it as a fresh entry in the SAME journal without
  // re-running the convert IPC. `journal_id` is required — `createEntry`'s
  // insert is FK-constrained, so the original entry's journal is the natural
  // home for the salvage. Cleared on confirm or cancel.
  const pendingBlockDeltaRef = useRef<{ markdown: string; journalId: string } | null>(null)
  // Guards `loadDraft` against double-firing the drafting IPC. The dialog's
  // load effect re-runs when `loadDraft`'s identity changes (`convertMode`
  // dep) and React 19 StrictMode double-invokes mount effects in dev, so
  // without this the backend `convertChatToEntry` / `convertChatDeltaToEntry`
  // can run twice per open. Once a draft resolves for the current mode, the
  // cached markdown is returned on any re-invocation until `openConvert`
  // resets both refs for the next dialog session.
  const draftLoadedForModeRef = useRef<'save' | 'update' | null>(null)
  const draftCacheRef = useRef<string>('')
  const transcriptRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const prefersReducedMotion = usePrefersReducedMotion()
  // After selecting a session (or sending), force-scroll once messages
  // land — the follow-mode heuristic would skip when scrolled up.
  // Kept until messages are non-empty so we don't consume the flag on the
  // empty placeholder render before `dailyChatLoadSession` resolves.
  const pendingForceScrollRef = useRef(false)
  // Drain the pre-attachment queue at most once per session id. The
  // *consumed value* lives in the ref (not just a marker), so the second
  // StrictMode mount pass — which must not call the destructive store API
  // again — still recovers the entry id and the chip is applied. Same
  // pattern as `EditorPanel`'s template / chat-draft drain.
  const drainedAttachmentForSessionRef = useRef<{
    sessionId: string
    entryId: string | null
  } | null>(null)

  const attachmentRefs = attachments.map(toAttachmentRef)
  const { preflight } = useChatContextPreflight(attachmentRefs, input, ragEnabled === true)

  // `needs_confirmation` is the only refusal code that opens a dialog —
  // the other three are shown inline via `ChatAttachmentBar`'s `refusal`
  // prop (see `inlineRefusal`). Derived directly from the hook's
  // `refusal` state (not mirrored into local state via an effect): an
  // in-flight `doSend` call's closure still holds the pre-send render's
  // values, so branching on the send outcome has to happen reactively,
  // and deriving during render is the correct way to react to a value
  // that already lives in state one level down.
  const confirmRefusal =
    refusal?.code === 'needs_confirmation' && refusal !== dismissedRefusal ? refusal : null

  useEffect(() => {
    if (!sessionId) {
      pendingForceScrollRef.current = false
      return
    }
    pendingForceScrollRef.current = true
  }, [sessionId])

  // Drain a pending pre-attachment enqueued by "AI → Start a chat" from the
  // entry card. Crosses a view boundary (Entries → Chat) so the hand-off
  // goes through `chatPendingAttachmentsStore`, keyed by the draft session
  // id minted at the click site — see `EntryContextMenu.handleStartChat`.
  // One-shot: `consume` deletes the queue entry on read, so a draft mounts
  // with its pre-attached entry exactly once. Respects the AI-content rule
  // (cf:conventions/ai-content-gathering-must-exclude-locked-entries-like-invisible-ones):
  // locked / invisible entries are never egressed to providers, so we drop
  // the chip and toast instead of silently no-op'ing.
  useEffect(() => {
    if (!sessionId) return
    // Consume once per session id; cache the result so StrictMode's second
    // mount pass recovers the same entry id instead of re-calling the
    // destructive store API (which would return null and drop the chip).
    if (drainedAttachmentForSessionRef.current?.sessionId !== sessionId) {
      const consumed = useChatPendingAttachmentsStore.getState().consume(sessionId)
      drainedAttachmentForSessionRef.current = {
        sessionId,
        entryId: consumed?.entryId ?? null,
      }
    }
    const entryId = drainedAttachmentForSessionRef.current.entryId
    if (!entryId) return
    let cancelled = false
    void getEntry(entryId)
      .then((entry) => {
        if (cancelled) return
        if (!entry || entry.is_locked || entry.is_invisible) {
          toast(
            t('daily_chat.attach_entry_unavailable', {
              defaultValue: "This entry can't be attached to a chat.",
            }),
          )
          return
        }
        setAttachments((prev) =>
          mergeConsumedEntryChip(prev, {
            kind: 'entry',
            id: entry.id,
            title: entry.title,
            entryDate: entry.entry_date,
          }),
        )
      })
      .catch((err) => {
        if (cancelled) return
        console.error('Failed to load pre-attached entry:', err)
      })
    return () => {
      cancelled = true
    }
    // `sessionId` is the only reactive input — `t` is stable from i18n and
    // `setAttachments` is a session-scoped write-through setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // Force-scroll on session select / send (smooth once); stay pinned while
  // the assistant streams; otherwise follow tokens only when near the bottom.
  useEffect(() => {
    const el = transcriptRef.current
    if (!el) return

    const decision = resolveTranscriptScrollMode({
      pendingForce: pendingForceScrollRef.current,
      pinToBottom: turn.kind === 'streaming',
      messageCount: messages.length,
    })
    if (decision.clearPending) pendingForceScrollRef.current = false
    if (!decision.mode) return

    // Smooth only for the one-shot pending force (session open / send).
    // Stream follow-ups stay instant so each token doesn't restart smooth.
    const smooth = decision.mode === 'force' && decision.clearPending && !prefersReducedMotion
    scrollTranscriptToBottom(el, {
      mode: decision.mode,
      smooth,
    })
  }, [messages, turn.kind, prefersReducedMotion])

  // Surface error turns via toast. The bubble itself shows an inline
  // error, but a toast is more visible while typing.
  useEffect(() => {
    if (turn.kind !== 'error') return
    const i18nKey = knownErrorCodes[turn.code] ?? 'daily_chat.error_unknown'
    toast(t(i18nKey, { defaultValue: 'Something went wrong.' }))
  }, [turn, t])

  // Single-line by default; grows with wrapped text / Shift+Enter newlines
  // (same pattern as the entry title field). Cap height so a long paste
  // scrolls inside the field instead of eating the transcript.
  const resizeInput = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [])

  useEffect(() => {
    resizeInput()
  }, [input, resizeInput])

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      void doSend()
    }
  }

  // Always attempts the send with `oversizeConfirmed: false` first — the
  // preflight estimate is debounced and may be null/stale/errored right
  // when Send is pressed, so it is never a pre-send gate (README decision
  // 17). `resolveChatSendPayload` intentionally has no preflight input
  // (regression-guarded in chatSendDecision.test.ts). The backend
  // recomputes the plan on every send and is the only thing that always
  // knows the true size; a `needs_confirmation` refusal is what reopens
  // this exact turn with `oversizeConfirmed: true` below.
  async function doSend(oversizeConfirmed = false) {
    if (!isDailyChatActionEnabled(ready)) return
    const payload = resolveChatSendPayload({
      oversizeConfirmed,
      input,
      pending: pendingSendRef.current,
      attachmentRefs,
      turnIsStreaming: turn.kind === 'streaming',
    })
    if (!payload) return
    if (payload.clearComposer) {
      setInput('')
      if (sessionId) useChatComposerDraftStore.getState().clearDraft(sessionId)
      pendingSendRef.current = { text: payload.text, attachments: payload.attachments }
    }
    // One-shot smooth jump even if the user had scrolled up; streaming
    // then keeps them pinned via `pinToBottom`.
    pendingForceScrollRef.current = true
    const ok = await sendMessage(payload.text, payload.attachments, oversizeConfirmed)
    if (ok) {
      // Each turn declares its own scope (README decision 4) — clear the
      // chip bar only once the turn was actually accepted. Kept intact on
      // a failed or refused send so the user doesn't have to re-pick.
      setAttachments([])
      if (sessionId) useChatComposerAttachmentsStore.getState().clearAttachments(sessionId)
      pendingSendRef.current = null
    }
    textareaRef.current?.focus({ preventScroll: true })
  }

  function handleConfirmSend() {
    setDismissedRefusal(refusal)
    void doSend(true)
  }

  /** Both entry affordances in a reply — the source list and an inline
   *  `[id=…]` badge — open a read-only modal rather than switching the tab
   *  to All Entries. Navigating away mid-conversation loses the reader's
   *  place in the thread they were following. */
  function openEntry(entryId: string) {
    setPreviewEntryId(entryId)
  }

  const renderEntryRef = useCallback(
    (entryId: string) => <EntryRefBadge entryId={entryId} onOpen={setPreviewEntryId} />,
    [],
  )

  /** Open the convert dialog in the given mode. `convertMode` drives which
   *  `loadDraft` and which save handler run while the dialog is mounted:
   *  'save' converts the whole chat into a new entry; 'update' appends only
   *  the delta since `convertedThroughSeq` to the existing entry. */
  function openConvert(mode: 'save' | 'update') {
    stashedThroughSeq.current = null
    // Fresh dialog session — clear the loadDraft dedupe cache so the
    // drafting IPC runs once for THIS open.
    draftLoadedForModeRef.current = null
    draftCacheRef.current = ''
    setConvertMode(mode)
    setShowConvertDialog(true)
  }

  // Save-mode: first conversion of this chat into a brand-new entry. Same
  // pipeline as before (split title/body, markdown→HTML seed, create entry,
  // enqueue draft) PLUS two Phase-3 changes: stamp the conversion watermark
  // via `markConverted`, and stop calling `reset()` so the conversation stays
  // visible with its link state intact (the user can keep chatting and later
  // hit "Update the entry"). `journalId` is required — the dialog disables
  // Save without one, and the FK-constrained insert would reject an empty id.
  async function handleSaveEntry(markdown: string, journalId: string) {
    if (!journalId) return
    // `loadDraft` always sets the watermark before Save can fire (the
    // dialog can't reach Save without loadDraft resolving first), so a
    // null here is a real invariant violation — surface it loudly instead
    // of stamping `convertedThroughSeq = 0`, which would make every future
    // assistant reply look "new since conversion". Checked FIRST so a throw
    // never leaves a committed entry orphaned from its watermark.
    if (stashedThroughSeq.current == null) {
      throw new Error('convertedThroughSeq missing at save-entry')
    }
    const throughSeq = stashedThroughSeq.current
    const { title, body } = splitTitleAndBody(markdown)
    // The AI draft is markdown — convert the body to HTML so the
    // editor can seed its Y.Doc on first mount via the chat-draft
    // queue. The body keeps the rest of the markdown grammar
    // (headings beyond the title H1, lists, emphasis) which the
    // converter mirrors into TipTap-compatible HTML.
    const bodyHtml = markdownToHtml(body)
    const newEntry = await createEntry({
      journal_id: journalId,
      title: title ?? undefined,
      content_text: body,
      preview_text: body.slice(0, 200),
      entry_date: Math.floor(Date.now() / 1000),
    })
    if (bodyHtml) {
      useChatDraftStore.getState().enqueuePendingChatDraft(newEntry.id, bodyHtml)
    }
    await markConverted(newEntry.id, throughSeq)
    setShowConvertDialog(false)
    setConvertMode(null)
    onSavedAsEntry?.()
    updateActiveTab({ activeView: 'entries', selectedEntryId: newEntry.id })
  }

  // Update-mode: append the delta since the last conversion to the existing
  // `convertedEntryId`. The delta is body-only (no title split), fronted by a
  // localized `<hr>` + bold marker line so each chat-derived update is
  // visually separated in the entry. Aborts to the block dialog if the target
  // is gone / locked / invisible — the editor never gets the append in that
  // case, and the user is offered a fresh save-as-new-entry instead.
  async function handleUpdateEntry(deltaMarkdown: string) {
    const targetId = convertedEntryId
    if (!targetId) return
    // Re-check the target right before appending — it may have been deleted
    // or locked since the session was last converted. `revealInvisible`
    // stays false: an invisible target is treated the same as a missing one
    // (mirrors the AI-content rule for locked/invisible entries).
    const target = await getEntry(targetId)
    if (!target || target.is_locked || target.is_invisible) {
      // Stash the delta plus the target's journal id (when known) so the
      // block dialog's "Save as new entry" confirm can re-file it as a
      // fresh entry in the SAME journal without re-running the IPC. A
      // deleted target has no journal, so the salvage handler guards on
      // an empty id and refuses the FK-violating insert.
      pendingBlockDeltaRef.current = {
        markdown: deltaMarkdown,
        journalId: target?.journal_id ?? '',
      }
      // Close the convert dialog so the two modals don't stack — the block
      // dialog's confirm handler runs the save-as-new flow independently
      // of `convertMode`, so nulling it here can't break that path.
      setShowConvertDialog(false)
      setConvertMode(null)
      setBlockDialogOpen(true)
      return
    }
    // Same invariant as the other save paths — see `handleSaveEntry`. Checked
    // FIRST so a throw never leaves a queued append orphaned from its watermark.
    if (stashedThroughSeq.current == null) {
      throw new Error('convertedThroughSeq missing at update-entry')
    }
    const throughSeq = stashedThroughSeq.current
    const dateLine = formatEntryDate(Math.floor(Date.now() / 1000), i18n.language)
    // `<hr>` is literal HTML — `markdownToHtml` has no `<hr>` grammar, but
    // HorizontalRule is a registered TipTap node so `setContent` parses it.
    // The marker text carries a locale date string, so it's HTML-escaped
    // (same rule `markdownToHtml` applies to model output).
    const appendHtml =
      '<hr>' +
      `<p><strong>${escapeHtmlText(t('daily_chat.update_marker', { date: dateLine }))}</strong></p>` +
      markdownToHtml(deltaMarkdown)
    useChatDraftStore.getState().enqueuePendingChatAppend(targetId, appendHtml)
    await markConverted(targetId, throughSeq)
    setShowConvertDialog(false)
    setConvertMode(null)
    updateActiveTab({ activeView: 'entries', selectedEntryId: targetId })
  }

  /** Dialog Save dispatcher — runs whichever handler matches the open mode.
   *  The dialog calls a single `onSave` with `(markdown, journalId)`; only
   *  the save path consumes `journalId`, so update mode ignores it. */
  async function handleDialogSave(markdown: string, journalId: string) {
    if (convertMode === 'update') {
      await handleUpdateEntry(markdown)
    } else {
      await handleSaveEntry(markdown, journalId)
    }
  }

  /** Block-dialog confirm: the update target is unusable, so re-file the
   *  stashed delta as a fresh entry. Mirrors `handleSaveEntry` minus the
   *  title split (the delta is body-only) — the new entry keeps the marker
   *  line as its leading content. Re-points `convertedEntryId` at the new
   *  entry via `markConverted`, which the backend allows. */
  async function handleBlockSaveAsNew() {
    const pending = pendingBlockDeltaRef.current
    pendingBlockDeltaRef.current = null
    if (!pending) return
    const { markdown: deltaMarkdown, journalId } = pending
    // The blocked target's journal is the natural home for the salvage.
    // If it's missing (target was hard-deleted so we never learned its
    // journal), bail instead of attempting an FK-violating insert —
    // mirrors `handleSaveEntry`'s `if (!journalId) return` guard.
    if (!journalId) {
      console.error('[ChatConversation] handleBlockSaveAsNew: missing journalId for blocked target')
      setBlockDialogOpen(false)
      return
    }
    // `loadDraft` always sets the watermark before any save can fire, so a
    // null here is a real invariant violation — surface it loudly instead
    // of stamping `convertedThroughSeq = 0`, which would make every future
    // assistant reply look "new since conversion". Checked FIRST so a throw
    // never leaves a committed salvage entry orphaned from its watermark.
    if (stashedThroughSeq.current == null) {
      throw new Error('convertedThroughSeq missing at block-save-as-new')
    }
    const throughSeq = stashedThroughSeq.current
    const bodyHtml = markdownToHtml(deltaMarkdown)
    const newEntry = await createEntry({
      journal_id: journalId,
      title: undefined,
      content_text: deltaMarkdown,
      preview_text: deltaMarkdown.slice(0, 200),
      entry_date: Math.floor(Date.now() / 1000),
    })
    if (bodyHtml) {
      useChatDraftStore.getState().enqueuePendingChatDraft(newEntry.id, bodyHtml)
    }
    await markConverted(newEntry.id, throughSeq)
    setShowConvertDialog(false)
    setConvertMode(null)
    setBlockDialogOpen(false)
    onSavedAsEntry?.()
    updateActiveTab({ activeView: 'entries', selectedEntryId: newEntry.id })
  }

  // loadDraft branches on mode: 'update' asks the backend for just the delta
  // since `convertedThroughSeq`; 'save' (and the implicit null fallback) ask
  // for the full chat. Both stash `throughSeq` so the matching save handler
  // can fold it into `markConverted` after the user accepts the draft. The
  // leading dedupe guard short-circuits re-invocations from the SAME mode
  // (the dialog's `useEffect` re-runs on `loadDraft` identity changes and
  // React 19 StrictMode double-invokes mount effects in dev) so the drafting
  // IPC fires exactly once per dialog-open — `openConvert` clears the cache
  // when starting a fresh session.
  const loadDraft = useCallback(async () => {
    if (draftLoadedForModeRef.current === convertMode) {
      return draftCacheRef.current
    }
    let markdown: string
    if (convertMode === 'update') {
      const r = await convertDelta()
      stashedThroughSeq.current = r.throughSeq
      markdown = r.markdown
    } else {
      const r = await convertToEntry()
      stashedThroughSeq.current = r.throughSeq
      markdown = r.markdown
    }
    draftCacheRef.current = markdown
    draftLoadedForModeRef.current = convertMode
    return markdown
  }, [convertMode, convertDelta, convertToEntry])

  // Empty state when no session is selected.
  if (!sessionId) {
    return (
      <div className="text-fg-secondary flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-sm">
        <MessageSquare className="text-accent size-8" aria-hidden />
        <p className="font-medium">
          {t('daily_chat.no_session_title', { defaultValue: 'No conversation selected' })}
        </p>
        <p className="max-w-80 text-xs">
          {t('daily_chat.no_session_hint', {
            defaultValue: 'Click "New chat" on the left to start a new conversation.',
          })}
        </p>
      </div>
    )
  }

  // Pure resolver drives the Save / Update / Update-disabled button from
  // session facts (Phase 3 T1). `canConvert` is the same "any non-streaming
  // assistant reply exists" check the old block used; the resolver then picks
  // the kind from the conversion watermark + whether new replies landed.
  const canConvert = messages.some((m) => m.role === 'assistant' && !m.streaming)
  const isStreaming = turn.kind === 'streaming'
  const buttonState = resolveEntryButtonState({
    hasNonStreamingAssistant: canConvert,
    isStreaming,
    convertedEntryId,
    newSinceConversion,
  })

  return (
    <div className="flex h-full w-full min-w-0 flex-col">
      <header className="border-border-default flex w-full shrink-0 items-center justify-between gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <MessageCircleMore className="text-accent size-6" aria-hidden />
          <h2 className="text-fg text-base font-semibold">
            {t('daily_chat.title', { defaultValue: 'Daily Chat' })}
          </h2>
        </div>
        <div className="flex items-center gap-1">
          {buttonState.kind === 'save' && (
            <Button
              variant="primary"
              size="sm"
              disabled={!buttonState.enabled}
              onClick={() => openConvert('save')}
            >
              <Sparkle className="size-3.5" aria-hidden />
              <span>{t('daily_chat.save_as_entry', { defaultValue: 'Save as entry' })}</span>
            </Button>
          )}
          {buttonState.kind === 'update' && (
            <Button
              variant="primary"
              size="sm"
              disabled={!buttonState.enabled}
              onClick={() => openConvert('update')}
            >
              <Sparkle className="size-3.5" aria-hidden />
              <span>{t('daily_chat.update_entry', { defaultValue: 'Update the entry' })}</span>
            </Button>
          )}
          {buttonState.kind === 'update-disabled' && (
            <Tooltip
              content={t('daily_chat.update_no_new', {
                defaultValue: 'No new messages since you last saved this conversation.',
              })}
            >
              <Button variant="primary" size="sm" disabled>
                <Sparkle className="size-3.5" aria-hidden />
                <span>{t('daily_chat.update_entry', { defaultValue: 'Update the entry' })}</span>
              </Button>
            </Tooltip>
          )}
          {/* Entry link: navigates to the entry tab (not the read-only
              preview modal `EntryRefBadge` opens mid-conversation — the
              header affordance is "go to the entry I generated from this
              chat"). Shown only once a conversion exists. */}
          {convertedEntryId && (
            <Tooltip
              content={t('daily_chat.entry_link_label', {
                defaultValue: 'Open the generated entry',
              })}
            >
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('daily_chat.entry_link_label', {
                  defaultValue: 'Open the generated entry',
                })}
                onClick={() =>
                  updateActiveTab({
                    activeView: 'entries',
                    selectedEntryId: convertedEntryId,
                  })
                }
              >
                <ArrowUpRight className="size-3.5" aria-hidden />
              </Button>
            </Tooltip>
          )}
        </div>
      </header>

      <div ref={transcriptRef} className="flex-1 overflow-y-auto px-4 py-4">
        {/* Same horizontal span as the composer below — full pane width. */}
        <div className="flex w-full flex-col gap-4">
          {messages.length === 0 && (
            <div className="text-fg-secondary py-12 text-center text-sm">
              <p>
                {t('daily_chat.empty_hint', {
                  defaultValue:
                    "Tell me about your day. I'll ask follow-up questions to help you reflect.",
                })}
              </p>
            </div>
          )}
          {messages.map((m) => {
            const isUser = m.role === 'user'
            const showModelInfo = Boolean(
              !isUser && showMessageMeta && !m.streaming && m.meta?.modelId,
            )
            // Resolved (not just raw-id) memory visibility — `hasMemories(m)`
            // alone is true even when every id turns out deleted, which used
            // to leave an empty flex wrapper div with no visible content once
            // `MemoriesUsedChip` rendered null (review suggestion). While the
            // shared fetch is still loading, keep showing the wrapper — the
            // chip itself hides during loading too, this only avoids the flash
            // of the wrapper disappearing then reappearing once resolved.
            const showMemories =
              hasMemories(m) &&
              (memoryTexts.loading || (m.memoryIds ?? []).some((id) => memoryTexts.texts.has(id)))
            // Meta (time / sources / model / memories) now sits *below* the
            // bubble rather than inside it — a solid accent fill leaves no
            // readable room for muted text. Gate is unchanged: any one of them
            // shows the row.
            const showMeta =
              typeof m.createdAt === 'number' || hasSources(m) || showModelInfo || showMemories

            return (
              <div key={m.id} className={cn('flex w-full min-w-0', isUser && 'justify-end')}>
                <div
                  className={cn(
                    'flex max-w-[85%] min-w-0',
                    isUser ? 'flex-col' : 'items-start gap-2.5',
                  )}
                >
                  {!isUser && (
                    <span
                      className="border-border-default bg-accent-soft flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full border select-none"
                      aria-hidden="true"
                    >
                      <img
                        src="/logo-without-container/256.png"
                        width={24}
                        height={24}
                        alt=""
                        draggable={false}
                        className="size-6"
                      />
                    </span>
                  )}
                  <div
                    className={cn('flex min-w-0 flex-col', isUser ? 'items-end' : 'items-start')}
                  >
                    {isUser && m.attachments && m.attachments.length > 0 && (
                      <MessageAttachmentChips
                        attachments={m.attachments}
                        locale={i18n.language}
                        t={t}
                      />
                    )}
                    <article
                      className={cn(
                        'w-fit max-w-full text-sm',
                        isUser
                          ? // Squared bottom-right corner is the tail pointing
                            // back at the composer. Pair is mode-aware (warm
                            // paper chip in Signature light, graphite in dark).
                            'bg-bubble-user text-bubble-user-text rounded-2xl rounded-br-md px-3.5 pt-2.5 pb-2.5'
                          : // Flat — no bubble. Assistant replies sit as plain
                            // text on the pane background so the user's own
                            // messages carry the visual weight. No left padding:
                            // the logo + gap already separate the mark from the
                            // first line.
                            'text-fg pt-0.5',
                      )}
                      data-role={m.role}
                    >
                      {m.role === 'assistant' ? (
                        <div>
                          {m.content ? (
                            renderSimpleMarkdown(m.content, { renderEntryRef })
                          ) : m.streaming ? (
                            <span className="text-fg-secondary inline-flex items-center gap-2">
                              <InlineOrb state="solving" aria-hidden />
                              <ShimmerText className="text-sm">
                                {t('daily_chat.thinking', { defaultValue: 'Thinking…' })}
                              </ShimmerText>
                            </span>
                          ) : null}
                          {m.errorCode && (
                            <p className="text-danger-text mt-1 text-xs">
                              {knownErrorCodes[m.errorCode]
                                ? t(knownErrorCodes[m.errorCode])
                                : (m.errorMessage ??
                                  t('daily_chat.error_unknown', {
                                    defaultValue: "Couldn't generate a reply.",
                                  }))}
                            </p>
                          )}
                        </div>
                      ) : (
                        <p className="whitespace-pre-wrap">{m.content}</p>
                      )}
                    </article>
                    {showMeta && (
                      <div className={cn('mt-1 flex items-center gap-2', isUser && 'px-3.5')}>
                        {typeof m.createdAt === 'number' && (
                          <span className="text-fg-muted text-xs">
                            {formatFriendlyRelativeTime(m.createdAt, i18n.language)}
                          </span>
                        )}
                        {(hasSources(m) || showModelInfo || showMemories) && (
                          <div className="flex items-center gap-1">
                            {hasSources(m) && (
                              <ChatSourceChips
                                sourceEntryIds={m.sourceEntryIds ?? []}
                                onOpenEntry={openEntry}
                              />
                            )}
                            {showModelInfo && m.meta && <MessageInfoPopover meta={m.meta} />}
                            {showMemories && (
                              <MemoriesUsedChip
                                memoryIds={m.memoryIds ?? []}
                                texts={memoryTexts.texts}
                                loading={memoryTexts.loading}
                              />
                            )}
                          </div>
                        )}
                        {!isUser && m.content && <MessageCopyButton content={m.content} t={t} />}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Full-width composer: footer is 100% of the conversation panel;
          the textarea takes remaining row space via flex-1. */}
      <footer className="border-border-default w-full shrink-0 border-t px-2 py-2">
        <div className="flex w-full min-w-0 flex-col gap-2">
          <ChatAttachmentBar
            attachments={attachments}
            onRemove={(index) => setAttachments((prev) => prev.filter((_, i) => i !== index))}
            preflight={preflight}
            refusal={inlineRefusal(refusal)}
          />
          <div className="flex w-full min-w-0 items-center gap-1.5">
            <Button
              ref={attachButtonRef}
              variant="ghost"
              size="sm"
              aria-label={t('daily_chat.attach', { defaultValue: 'Attach' })}
              aria-haspopup="dialog"
              aria-expanded={attachPopoverOpen}
              aria-controls={attachPopoverOpen ? attachPopoverId : undefined}
              onClick={() => setAttachPopoverOpen((open) => !open)}
              className="shrink-0"
              icon={<Paperclip className="size-4" aria-hidden />}
            />
            <ChatRagToggle />
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => {
                const next = e.target.value
                setInput(next)
                if (sessionId) useChatComposerDraftStore.getState().setDraft(sessionId, next)
              }}
              onKeyDown={handleKeyDown}
              placeholder={t('daily_chat.input_placeholder', {
                defaultValue: 'Tell me about your day…',
              })}
              disabled={isStreaming}
              rows={1}
              className="border-border-default bg-panel-1 text-fg max-h-40 min-h-9 min-w-0 flex-1 resize-none overflow-y-auto rounded-lg border px-3 py-2 text-sm leading-normal wrap-break-word [-ms-overflow-style:none] [scrollbar-width:none] focus:outline-none disabled:opacity-50 [&::-webkit-scrollbar]:hidden"
            />
            {isStreaming ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={cancelTurn}
                aria-label={t('daily_chat.stop', { defaultValue: 'Stop' })}
                className="h-auto w-auto shrink-0 px-2 py-0 hover:bg-transparent"
                icon={<Square className="size-4" aria-hidden />}
              />
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void doSend()}
                disabled={!input.trim() || !isDailyChatActionEnabled(ready)}
                aria-label={t('daily_chat.send', { defaultValue: 'Send' })}
                className="text-accent hover:text-accent h-auto w-auto shrink-0 px-2 py-0 hover:bg-transparent disabled:opacity-40"
                icon={<SendHorizontal className="size-5" aria-hidden />}
              />
            )}
          </div>
        </div>
        <ChatAttachPopover
          open={attachPopoverOpen}
          onClose={() => setAttachPopoverOpen(false)}
          anchorRef={attachButtonRef}
          id={attachPopoverId}
          attachments={attachments}
          onSelect={(attachment) => {
            setAttachments((prev) => [...prev, attachment])
            setAttachPopoverOpen(false)
          }}
          onCommitEntries={(entries) => {
            // Replace entry-kind attachments with the popover's final
            // selection (dedupe by id is enforced there); keep period-kind
            // attachments untouched, and preserve the existing order for
            // anything still selected instead of reshuffling the chip bar —
            // only genuinely new picks get appended at the end.
            setAttachments((prev) => {
              const selectedIds = new Set(entries.map((e) => e.id))
              const kept = prev.filter((a) => a.kind !== 'entry' || selectedIds.has(a.id))
              const keptIds = new Set(kept.flatMap((a) => (a.kind === 'entry' ? [a.id] : [])))
              const added = entries.filter((e) => !keptIds.has(e.id))
              return [...kept, ...added]
            })
            setAttachPopoverOpen(false)
          }}
        />
      </footer>

      {showConvertDialog && (
        <ConvertToEntryDialog
          loadDraft={loadDraft}
          onSave={handleDialogSave}
          onCancel={() => {
            setShowConvertDialog(false)
            setConvertMode(null)
          }}
          title={
            convertMode === 'update'
              ? t('daily_chat.convert_modal.update_title', {
                  defaultValue: 'Update your journal entry',
                })
              : undefined
          }
          saveLabel={
            convertMode === 'update'
              ? t('daily_chat.convert_modal.update_save', {
                  defaultValue: 'Update entry',
                })
              : undefined
          }
          showJournalPicker={convertMode !== 'update'}
        />
      )}

      <ConfirmDialog
        open={blockDialogOpen}
        title={t('daily_chat.update_target_unavailable_title', {
          defaultValue: "Can't update that entry",
        })}
        description={t('daily_chat.update_target_unavailable_body', {
          defaultValue:
            'The entry this conversation created is no longer available (deleted or locked). Save the new messages as a separate entry instead?',
        })}
        confirmLabel={t('daily_chat.save_as_new_entry', {
          defaultValue: 'Save as a new entry',
        })}
        onConfirm={handleBlockSaveAsNew}
        onClose={() => setBlockDialogOpen(false)}
      />

      {confirmRefusal && (
        <ChatContextConfirmDialog
          refusal={confirmRefusal}
          onConfirm={handleConfirmSend}
          onCancel={() => setDismissedRefusal(refusal)}
        />
      )}

      {previewEntryId !== null && (
        // Keyed on the id so opening a second entry while the first is still
        // showing remounts the modal and re-runs its fetch, rather than
        // leaving the previous entry's text under a new heading.
        <EntryPreviewModal
          key={previewEntryId}
          entryId={previewEntryId}
          onClose={() => setPreviewEntryId(null)}
          onEdit={(id) => {
            setPreviewEntryId(null)
            updateActiveTab({ activeView: 'entries', selectedEntryId: id })
          }}
        />
      )}
    </div>
  )
}

// ─── MemoriesUsedChip ────────────────────────────────────────────────────────

interface MemoriesUsedChipProps {
  /** `ChatMessage.memoryIds` — memory item ids folded into THIS reply's
   *  prompt. */
  memoryIds: string[]
  /** Resolved id → text lookup for the WHOLE transcript, from a single
   *  `useMemoryTexts` call at the `ChatConversation` level — not one call
   *  per chip, so a transcript with N memory-using turns makes one
   *  `listMemoryItems()` fetch instead of N (review suggestion). */
  texts: MemoryTextLookup
  loading: boolean
}

/** Brain trigger (icon + memory count, mirroring `ChatSourceChips`) under an
 *  assistant reply — the count is tooltip-labelled rather than spelled out
 *  inline. Driven by that
 *  message's own persisted `memoryIds` (survives reload — see the hook's doc
 *  comment; this replaced a session-level, turn-only indicator that vanished
 *  on the next turn or a reload). Click opens a floating-ui popover listing
 *  the memory texts — same setup as `ChatSourceChips` / `MessageInfoPopover`
 *  (`fixed` strategy + portal to escape the transcript's `overflow-y-auto`,
 *  flip/shift to avoid clipping at pane edges, `FloatingFocusManager` for a
 *  focus trap). Honours dark mode (semantic tokens only).
 *
 *  Renders nothing while resolving, or once resolved if every id turned out
 *  to be deleted — the count and list both come from the resolved set, not
 *  the raw id count, so a deleted memory can't inflate either. A disabled
 *  (but not deleted) memory still resolves and shows its text: the turn
 *  genuinely used it, and disabling it later doesn't rewrite history. */
function MemoriesUsedChip({ memoryIds, texts, loading }: MemoriesUsedChipProps) {
  const { t } = useTranslation('ai')
  const [open, setOpen] = useState(false)
  const labelId = useId()
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'top-end',
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
  })
  const click = useClick(context)
  const dismiss = useDismiss(context)
  const role = useRole(context, { role: 'dialog' })
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss, role])

  const memories = memoryIds.flatMap((id) => {
    const text = texts.get(id)
    return text === undefined ? [] : [{ id, text }]
  })

  if (loading || memories.length === 0) return null

  return (
    <div className="inline-flex">
      <Tooltip content={t('user_memory.memories_used_tooltip')}>
        <Button
          ref={refs.setReference}
          type="button"
          variant="ghost"
          size="sm"
          aria-label={t('user_memory.memories_used_count', { count: memories.length })}
          aria-haspopup="dialog"
          aria-expanded={open}
          className="text-fg-muted hover:text-fg h-6 gap-1 px-1.5"
          {...getReferenceProps()}
        >
          <Brain className="size-3.5" aria-hidden />
          <span className="text-2xs font-medium tabular-nums" aria-hidden>
            {memories.length}
          </span>
        </Button>
      </Tooltip>
      {open && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false} returnFocus>
            <div
              ref={refs.setFloating}
              style={floatingStyles}
              {...getFloatingProps()}
              aria-labelledby={labelId}
              // `overflow-hidden` is load-bearing (same as ChatSourceChips):
              // without a paint clip on the rounded box, WebKit lets the inner
              // scroll layer draw list rows outside the panel border while
              // scrolling.
              className="border-border-default bg-elevated z-(--z-tooltip) w-64 max-w-[80vw] overflow-hidden rounded-xl border p-2 shadow-(--elev-3)"
            >
              <p id={labelId} className="sr-only">
                {t('user_memory.memories_used_count', { count: memories.length })}
              </p>
              {/* `overscroll-contain`: end of this list must not chain-scroll
                  the transcript underneath (popover is `strategy: 'fixed'`). */}
              <ul className="max-h-60 space-y-1 overflow-y-auto overscroll-contain">
                {memories.map((m) => (
                  <li
                    key={m.id}
                    className="text-fg-secondary border-border-default border-b py-1 text-xs leading-relaxed last:border-b-0 last:pb-0"
                  >
                    {m.text}
                  </li>
                ))}
              </ul>
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </div>
  )
}
