import { useCallback, useEffect, useReducer, useRef } from 'react'
import { listen } from '@tauri-apps/api/event'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { extractAiErrorCode } from '../lib/aiErrorCode'
import {
  cancelSuggestion,
  convertChatDeltaToEntry,
  convertChatToEntry,
  dailyChatGenerateTitle,
  dailyChatLoadSession,
  dailyChatMarkConverted,
  dailyChatSendTurn,
  getAiSettings,
} from '../lib/tauri'
import type {
  AiMessageMeta,
  ChatAttachmentRef,
  ChatContextRefusal,
  EndpointClass,
} from '../types/ai'
import { aiMessageMetaFromWire } from '../types/ai'

const TITLE_GEN_MIN_USER_REPLY_CHARS = 15

/**
 * Daily Chat conversation hook (Phase 6 v2 R9 v2).
 *
 * Bound to a specific `sessionId` — when null, the hook is a no-op
 * and the consumer should render an empty state. When set, the hook:
 *   1. On mount / sessionId change → load history from the backend.
 *   2. `sendMessage(text)` → optimistic-append user + assistant
 *      placeholder, fire `daily_chat_send_turn`, stream tokens into
 *      the placeholder. The backend persists user + assistant rows.
 *   3. Cancel / error / reset all behave the same as before; the
 *      cancelled placeholder is dropped (matches previous semantics
 *      and what the backend skips persisting).
 *
 * State machine for the active turn:
 *   `idle` → `streaming` → `done` | `error` | `cancelled` → `idle`
 */

export interface ChatMessage {
  /** Locally-minted id (used as React key). */
  id: string
  role: 'user' | 'assistant'
  /** Final content. While streaming, equal to `partial`. */
  content: string
  /** Unix seconds create time when known (loaded history / optimistic send). */
  createdAt?: number
  /** True while the assistant turn is still streaming. */
  streaming?: boolean
  /** Stable error code if this assistant turn failed. */
  errorCode?: string
  /** Raw upstream error message — surfaced to the user when `errorCode`
   *  isn't in the known-codes map so they can see what actually failed
   *  (HTTP status + provider response body, scrubbed). */
  errorMessage?: string
  /** AI call metadata for assistant replies (null/undefined on user messages). */
  meta?: AiMessageMeta
  /** What the user attached to THIS turn — user rows only. Rendered as
   *  chips above the message bubble, so a months-old transcript still
   *  shows what the model was actually given. */
  attachments?: ChatAttachmentRef[]
  /** Entry ids whose content actually reached the prompt — assistant
   *  rows only. Drives the source chips under an answer. */
  sourceEntryIds?: string[]
  /** Memory item ids folded into THIS reply's prompt — assistant rows
   *  only. Drives the "N memories used" chip under this specific answer
   *  (persisted, unlike the old session-level indicator — survives a
   *  reload). Text is resolved live via `useMemoryTexts`, not stored here. */
  memoryIds?: string[]
  /** Persisted message seq from the backend. Set on loaded history;
   *  `undefined` for optimistically-streamed messages that haven't been
   *  reloaded yet (they have no row yet). Drives the conversion
   *  high-water comparison against `convertedThroughSeq`. */
  seq?: number
}

export type TurnState =
  | { kind: 'idle' }
  | { kind: 'streaming'; turnId: string; messageId: string }
  | { kind: 'error'; turnId: string; messageId: string; code: string }

interface State {
  messages: ChatMessage[]
  turn: TurnState
  /** The last rejected send's `ChatContextRefused` payload, distinct from
   *  the generic `turn: { kind: 'error' }` state — a refusal isn't a
   *  provider/network failure, it's the backend declining to send at all
   *  (see `daily_chat_send_turn_inner`'s doc comment: nothing is persisted
   *  in either refusal case). Cleared at the start of every new send
   *  attempt and on session load/reset; overwritten by the next refusal. */
  refusal: ChatContextRefusal | null
  /** The entry id this session was last converted into, or `null` when the
   *  session has never been saved as an entry. Mirrors
   *  `ChatSession.convertedEntryId` from the backend. */
  convertedEntryId: string | null
  /** Highest persisted assistant message seq already folded into
   *  {@link convertedEntryId}. `null` when nothing has been converted yet. */
  convertedThroughSeq: number | null
  /** True when an assistant turn has arrived since the last conversion
   *  (i.e. there's a newer reply the saved entry doesn't yet contain).
   *  Computed on load as "any assistant seq > convertedThroughSeq", and
   *  flipped to `true` on each completed assistant turn while a conversion
   *  already exists. Drives the Save/Update button label in T1. */
  newSinceConversion: boolean
}

type Action =
  | {
      type: 'load'
      messages: ChatMessage[]
      convertedEntryId: string | null
      convertedThroughSeq: number | null
    }
  | {
      type: 'send'
      userId: string
      assistantId: string
      turnId: string
      userText: string
      attachments: ChatAttachmentRef[]
    }
  | { type: 'token'; turnId: string; messageId: string; delta: string }
  | {
      type: 'complete'
      turnId: string
      messageId: string
      final: string
      meta?: AiMessageMeta
      sourceEntryIds?: string[]
      memoriesUsed?: MemoryUsedWire[]
    }
  | { type: 'error'; turnId: string; messageId: string; code: string; message?: string }
  | { type: 'cancelled'; turnId: string; messageId: string }
  | {
      type: 'refused'
      turnId: string
      /** The assistant placeholder. */
      messageId: string
      /** The optimistic user bubble — also dropped, since a refusal
       *  persists nothing server-side. */
      userMessageId: string
      refusal: ChatContextRefusal
    }
  | { type: 'reset' }
  | { type: 'markConverted'; entryId: string; throughSeq: number }

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'load': {
      // newSinceConversion: only meaningful once an entry exists. A session
      // with no convertedEntryId has nothing to be "new since" — it's all
      // new, but the button shows Save, not Update, so the flag stays
      // false. When an entry DOES exist, any assistant reply whose seq is
      // above the high-water mark means the saved entry is stale.
      const newSinceConversion =
        action.convertedEntryId != null &&
        action.messages.some(
          (m) =>
            m.role === 'assistant' && m.seq != null && m.seq > (action.convertedThroughSeq ?? -1),
        )
      return {
        messages: action.messages,
        turn: { kind: 'idle' },
        refusal: null,
        convertedEntryId: action.convertedEntryId,
        convertedThroughSeq: action.convertedThroughSeq,
        newSinceConversion,
      }
    }
    case 'send': {
      const nowSec = Math.floor(Date.now() / 1000)
      const userMsg: ChatMessage = {
        id: action.userId,
        role: 'user',
        content: action.userText,
        createdAt: nowSec,
        attachments: action.attachments.length > 0 ? action.attachments : undefined,
      }
      const placeholder: ChatMessage = {
        id: action.assistantId,
        role: 'assistant',
        content: '',
        createdAt: nowSec,
        streaming: true,
      }
      return {
        messages: [...state.messages, userMsg, placeholder],
        turn: { kind: 'streaming', turnId: action.turnId, messageId: action.assistantId },
        refusal: null,
        convertedEntryId: state.convertedEntryId,
        convertedThroughSeq: state.convertedThroughSeq,
        newSinceConversion: state.newSinceConversion,
      }
    }
    case 'token': {
      if (
        state.turn.kind !== 'streaming' ||
        state.turn.turnId !== action.turnId ||
        state.turn.messageId !== action.messageId
      ) {
        return state
      }
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.messageId ? { ...m, content: m.content + action.delta } : m,
        ),
      }
    }
    case 'complete': {
      if (
        state.turn.kind !== 'streaming' ||
        state.turn.turnId !== action.turnId ||
        state.turn.messageId !== action.messageId
      ) {
        return state
      }
      return {
        messages: state.messages.map((m) =>
          m.id === action.messageId
            ? {
                ...m,
                content: action.final,
                streaming: false,
                meta: action.meta,
                sourceEntryIds:
                  action.sourceEntryIds && action.sourceEntryIds.length > 0
                    ? action.sourceEntryIds
                    : undefined,
                // Persisted on the backend row too (see `ChatMessage.memoryIds`'s
                // doc comment) — set here as well so THIS reply's chip renders
                // immediately, before the next session load re-reads it from disk.
                memoryIds:
                  action.memoriesUsed && action.memoriesUsed.length > 0
                    ? action.memoriesUsed.map((mu) => mu.id)
                    : undefined,
              }
            : m,
        ),
        turn: { kind: 'idle' },
        refusal: state.refusal,
        convertedEntryId: state.convertedEntryId,
        convertedThroughSeq: state.convertedThroughSeq,
        // A freshly-completed assistant turn arrived after the last
        // conversion watermark, so the saved entry (if any) is now stale.
        // Only meaningful when a conversion already exists — without one,
        // the button shows Save (the whole chat is "new"), and the load
        // path is what computes the initial flag.
        newSinceConversion: state.convertedEntryId != null ? true : state.newSinceConversion,
      }
    }
    case 'error': {
      if (
        state.turn.kind !== 'streaming' ||
        state.turn.turnId !== action.turnId ||
        state.turn.messageId !== action.messageId
      ) {
        return state
      }
      return {
        messages: state.messages.map((m) =>
          m.id === action.messageId
            ? { ...m, streaming: false, errorCode: action.code, errorMessage: action.message }
            : m,
        ),
        turn: {
          kind: 'error',
          turnId: action.turnId,
          messageId: action.messageId,
          code: action.code,
        },
        refusal: state.refusal,
        convertedEntryId: state.convertedEntryId,
        convertedThroughSeq: state.convertedThroughSeq,
        newSinceConversion: state.newSinceConversion,
      }
    }
    case 'cancelled': {
      const filtered = state.messages.filter((m) => !(m.id === action.messageId && m.streaming))
      return {
        messages: filtered,
        turn: { kind: 'idle' },
        refusal: state.refusal,
        convertedEntryId: state.convertedEntryId,
        convertedThroughSeq: state.convertedThroughSeq,
        newSinceConversion: state.newSinceConversion,
      }
    }
    case 'refused': {
      if (
        state.turn.kind !== 'streaming' ||
        state.turn.turnId !== action.turnId ||
        state.turn.messageId !== action.messageId
      ) {
        return state
      }
      // Nothing was persisted server-side for a refused send (see
      // `daily_chat_send_turn_inner`, which returns before its first write),
      // so the transcript must drop BOTH optimistic rows — the streaming
      // placeholder and the user bubble.
      //
      // Keeping the user bubble looks kinder but is wrong: confirming a
      // `needs_confirmation` refusal replays the identical turn through
      // `sendMessage`, which appends a second user bubble, and the user sees
      // their own question twice. The attachments are not lost either way —
      // `ChatConversation` holds them in its own state and in
      // `pendingSendRef`, and restores the text into the composer.
      const filtered = state.messages.filter(
        (m) => m.id !== action.messageId && m.id !== action.userMessageId,
      )
      return {
        messages: filtered,
        turn: { kind: 'idle' },
        refusal: action.refusal,
        convertedEntryId: state.convertedEntryId,
        convertedThroughSeq: state.convertedThroughSeq,
        newSinceConversion: state.newSinceConversion,
      }
    }
    case 'reset': {
      // Clears conversion state because the only remaining callers of
      // `reset` are session-switch / null / not-found paths (the load
      // effect at lines marked `dispatch({ type: 'reset' })`), all of
      // which SHOULD wipe the prior session's "saved as entry X" water-
      // mark so it doesn't leak onto an unrelated session. This is safe
      // because the post-save flow (T4) no longer calls `reset` — it
      // keeps the conversation mounted with `markConverted` stamping
      // the watermark directly — and a successful `load` always over-
      // writes all three fields from the freshly-loaded session.
      return {
        messages: [],
        turn: { kind: 'idle' },
        refusal: null,
        convertedEntryId: null,
        convertedThroughSeq: null,
        newSinceConversion: false,
      }
    }
    case 'markConverted': {
      return {
        ...state,
        convertedEntryId: action.entryId,
        convertedThroughSeq: action.throughSeq,
        newSinceConversion: false,
      }
    }
  }
}

interface DailyChatTokenEvent {
  key: string
  delta: string
}

/** Memory items the backend folded into a Daily Chat turn's prompt
 *  (Phase 4 — `memoriesUsed` on the `ai:daily-chat-complete` payload).
 *  The wire shape is always `{ id, text }`; the array is present (possibly
 *  empty) even when the feature is off or zero memories matched. */
export interface MemoryUsedWire {
  id: string
  text: string
}

interface DailyChatCompleteEvent {
  key: string
  content: string
  modelId?: string | null
  providerId?: string | null
  endpointClass?: EndpointClass | null
  tokensIn?: number | null
  tokensOut?: number | null
  latencyMs?: number | null
  /** Entry ids whose content actually reached the prompt (deduped,
   *  first-seen order — see `daily_chat_send_turn_inner`'s doc comment).
   *  Always an array (possibly empty) on the wire. */
  sourceEntryIds?: string[]
  /** Memory items injected into this turn's prompt. Always an array
   *  (possibly empty) on the wire — Phase 4 emits `memoriesUsed: []` when
   *  the feature is off or no memories matched. */
  memoriesUsed?: MemoryUsedWire[]
}
interface DailyChatErrorEvent {
  key: string
  code: string
  message?: string
}
interface DailyChatCancelledEvent {
  key: string
}

let counter = 0
function mintId(prefix: string): string {
  counter += 1
  return `${prefix}-${Date.now()}-${counter}`
}

const REFUSAL_CODES = new Set<ChatContextRefusal['code']>([
  'period_too_large',
  'period_no_budget',
  'needs_confirmation',
  'consent_required',
])

/** `AiError::ChatContextRefused`'s `Display` impl is EXACTLY the refusal's
 *  own JSON serialisation — no prefix, no wrapping text (see
 *  `src-tauri/src/ai/error.rs`). `invoke()` rejects with that string
 *  verbatim, so this is the one place the frontend parses it back into
 *  the typed union. Never throws: a parse failure, or a string that
 *  isn't a refusal (e.g. a bare `AI_NOT_CONFIGURED` gate code), returns
 *  `null` so the caller falls back to the generic error path instead. */
function parseChatContextRefusal(e: unknown): ChatContextRefusal | null {
  if (typeof e !== 'string') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(e)
  } catch {
    return null
  }
  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    'code' in parsed &&
    typeof (parsed as { code: unknown }).code === 'string' &&
    REFUSAL_CODES.has((parsed as { code: ChatContextRefusal['code'] }).code)
  ) {
    return parsed as ChatContextRefusal
  }
  return null
}

export function useDailyChat(sessionId: string | null) {
  const [state, dispatch] = useReducer(reducer, {
    messages: [],
    turn: { kind: 'idle' },
    refusal: null,
    convertedEntryId: null,
    convertedThroughSeq: null,
    newSinceConversion: false,
  })

  const turnRef = useRef<TurnState>({ kind: 'idle' })
  turnRef.current = state.turn

  const messagesRef = useRef<ChatMessage[]>([])
  messagesRef.current = state.messages

  const sessionIdRef = useRef<string | null>(sessionId)
  sessionIdRef.current = sessionId

  const unlistenersRef = useRef<UnlistenFn[]>([])

  // Subscribe to streaming events once for the lifetime of the hook.
  // Events are keyed by `turnId`, so a single subscription handles
  // every session as long as the `turnRef` is correct.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const tokenU = await listen<DailyChatTokenEvent>('ai:daily-chat-token', (e) => {
        const t = turnRef.current
        if (t.kind !== 'streaming' || t.turnId !== e.payload.key) return
        dispatch({
          type: 'token',
          turnId: e.payload.key,
          messageId: t.messageId,
          delta: e.payload.delta,
        })
      })
      const completeU = await listen<DailyChatCompleteEvent>('ai:daily-chat-complete', (e) => {
        const t = turnRef.current
        if (t.kind !== 'streaming' || t.turnId !== e.payload.key) return
        const meta = aiMessageMetaFromWire(e.payload) ?? undefined
        dispatch({
          type: 'complete',
          turnId: e.payload.key,
          messageId: t.messageId,
          final: e.payload.content,
          meta,
          sourceEntryIds: e.payload.sourceEntryIds,
          memoriesUsed: e.payload.memoriesUsed,
        })
      })
      const errorU = await listen<DailyChatErrorEvent>('ai:daily-chat-error', (e) => {
        const t = turnRef.current
        if (t.kind !== 'streaming' || t.turnId !== e.payload.key) return
        dispatch({
          type: 'error',
          turnId: e.payload.key,
          messageId: t.messageId,
          code: e.payload.code,
          message: e.payload.message,
        })
      })
      const cancelU = await listen<DailyChatCancelledEvent>('ai:daily-chat-cancelled', (e) => {
        const t = turnRef.current
        if (t.kind !== 'streaming' || t.turnId !== e.payload.key) return
        dispatch({
          type: 'cancelled',
          turnId: e.payload.key,
          messageId: t.messageId,
        })
      })
      if (cancelled) {
        tokenU()
        completeU()
        errorU()
        cancelU()
        return
      }
      unlistenersRef.current = [tokenU, completeU, errorU, cancelU]
    })()
    return () => {
      cancelled = true
      for (const u of unlistenersRef.current) u()
      unlistenersRef.current = []
      const t = turnRef.current
      if (t.kind === 'streaming') {
        void cancelSuggestion(`daily-chat:${t.turnId}`).catch(() => {})
      }
    }
  }, [])

  // Load (or reload) history when the bound sessionId changes.
  //
  // A brand-new "New chat" is an unpersisted draft: the backend has no row and
  // `dailyChatLoadSession` rejects with `AI_DAILY_CHAT_SESSION_NOT_FOUND`,
  // which the catch turns into an empty transcript — exactly the empty state a
  // draft wants, with no separate skip needed. The one hazard is a load
  // resolving AFTER the user has already sent (a fresh draft they typed into,
  // or the backend having lazily created the row on that send): the optimistic
  // transcript is the truth then, so both the success and failure paths bail
  // out if a turn has started, rather than clobbering it with history/empty.
  useEffect(() => {
    if (!sessionId) {
      dispatch({ type: 'reset' })
      return
    }
    let alive = true
    void (async () => {
      try {
        const session = await dailyChatLoadSession(sessionId)
        if (!alive) return
        if (messagesRef.current.length > 0 || turnRef.current.kind !== 'idle') return
        const messages: ChatMessage[] = session.messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          createdAt: m.createdAt,
          meta: aiMessageMetaFromWire(m) ?? undefined,
          attachments: m.attachments ?? undefined,
          sourceEntryIds: m.sourceEntryIds ?? undefined,
          memoryIds: m.memoryIds ?? undefined,
          seq: m.seq,
        }))
        dispatch({
          type: 'load',
          messages,
          convertedEntryId: session.convertedEntryId,
          convertedThroughSeq: session.convertedThroughSeq,
        })
      } catch {
        if (!alive) return
        if (messagesRef.current.length > 0 || turnRef.current.kind !== 'idle') return
        dispatch({ type: 'reset' })
      }
    })()
    return () => {
      alive = false
    }
  }, [sessionId])

  const sendMessage = useCallback(
    async (
      userText: string,
      attachments: ChatAttachmentRef[] = [],
      oversizeConfirmed = false,
    ): Promise<boolean> => {
      const trimmed = userText.trim()
      if (!trimmed) return false
      const sid = sessionIdRef.current
      if (!sid) return false
      if (turnRef.current.kind === 'streaming') return false
      // Decide whether to consider LLM title-gen for THIS turn before
      // mutating state — once we dispatch `send`, the user-message count
      // flips from 0 → 1. The default truncated title is set on the
      // backend inside `daily_chat_send_turn`; this path only fires the
      // optional LLM upgrade when the setting is on.
      const isFirstUserTurn = !messagesRef.current.some((m) => m.role === 'user')
      const shouldRequestTitle = isFirstUserTurn && trimmed.length >= TITLE_GEN_MIN_USER_REPLY_CHARS

      const turnId = mintId('turn')
      const userId = mintId('u')
      const assistantId = mintId('a')
      dispatch({
        type: 'send',
        userId,
        assistantId,
        turnId,
        userText: trimmed,
        attachments,
      })
      try {
        await dailyChatSendTurn(sid, turnId, trimmed, attachments, oversizeConfirmed)
      } catch (e) {
        const refusal = parseChatContextRefusal(e)
        if (refusal) {
          dispatch({
            type: 'refused',
            turnId,
            messageId: assistantId,
            userMessageId: userId,
            refusal,
          })
        } else {
          const code = extractAiErrorCode(e) ?? 'AI_UNKNOWN_ERROR'
          dispatch({ type: 'error', turnId, messageId: assistantId, code })
        }
        return false
      }
      // Optional LLM title upgrade (gated by `dailyChatAiTitle`, default
      // off). The backend is also gated + idempotent; the truncated
      // first-message title from send_turn remains if generation fails.
      if (shouldRequestTitle) {
        void (async () => {
          const settings = await getAiSettings()
          if (!settings.dailyChatAiTitle) return
          await dailyChatGenerateTitle(sid)
        })().catch((err) => {
          console.warn('[useDailyChat] title-gen failed:', err)
        })
      }
      return true
    },
    [],
  )

  const cancelTurn = useCallback(async () => {
    const t = turnRef.current
    if (t.kind !== 'streaming') return
    dispatch({ type: 'cancelled', turnId: t.turnId, messageId: t.messageId })
    try {
      await cancelSuggestion(`daily-chat:${t.turnId}`)
    } catch {
      /* fire-and-forget */
    }
  }, [])

  const reset = useCallback(() => {
    const t = turnRef.current
    if (t.kind === 'streaming') {
      void cancelSuggestion(`daily-chat:${t.turnId}`).catch(() => {})
    }
    dispatch({ type: 'reset' })
  }, [])

  const convertToEntry = useCallback(async (): Promise<{
    markdown: string
    throughSeq: number
  }> => {
    const sid = sessionIdRef.current
    if (!sid) throw new Error('AI_DAILY_CHAT_NO_SESSION')
    // Returns the full { markdown, throughSeq } shape so the caller (T4
    // ChatConversation) can feed `throughSeq` into `markConverted` once
    // the entry has actually been created/saved.
    return convertChatToEntry(sid)
  }, [])

  const convertDelta = useCallback(async (): Promise<{ markdown: string; throughSeq: number }> => {
    const sid = sessionIdRef.current
    if (!sid) throw new Error('AI_DAILY_CHAT_NO_SESSION')
    // Returns the delta since the last conversion. Deliberately does NOT
    // touch local state — the caller decides whether to fold the result
    // into the existing entry and then call `markConverted`.
    return convertChatDeltaToEntry(sid)
  }, [])

  const markConverted = useCallback(async (entryId: string, throughSeq: number): Promise<void> => {
    const sid = sessionIdRef.current
    if (!sid) throw new Error('AI_DAILY_CHAT_NO_SESSION')
    await dailyChatMarkConverted(sid, entryId, throughSeq)
    dispatch({ type: 'markConverted', entryId, throughSeq })
  }, [])

  return {
    messages: state.messages,
    turn: state.turn,
    /** The last rejected send's refusal, or `null`. Distinct from
     *  `turn.kind === 'error'` — see `State.refusal`'s doc comment. */
    refusal: state.refusal,
    convertedEntryId: state.convertedEntryId,
    convertedThroughSeq: state.convertedThroughSeq,
    newSinceConversion: state.newSinceConversion,
    sendMessage,
    cancelTurn,
    reset,
    convertToEntry,
    convertDelta,
    markConverted,
  }
}
