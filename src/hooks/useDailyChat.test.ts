import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useDailyChat, type TurnState } from './useDailyChat'

type Handler<T> = (event: { payload: T }) => void
const handlers: Record<string, Handler<unknown>> = {}

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: Handler<unknown>) => {
    handlers[name] = handler
    return () => {
      delete handlers[name]
    }
  }),
}))

vi.mock('../lib/tauri', () => ({
  dailyChatSendTurn: vi.fn(),
  cancelSuggestion: vi.fn(),
  convertChatToEntry: vi.fn(),
  convertChatDeltaToEntry: vi.fn(),
  dailyChatMarkConverted: vi.fn(),
  dailyChatLoadSession: vi.fn(),
  dailyChatGenerateTitle: vi.fn(),
  getAiSettings: vi.fn(),
}))

import * as tauri from '../lib/tauri'
import type { AIFullSettings, ChatAttachmentRef } from '../types/ai'

const SETTINGS_OFF: AIFullSettings = {
  provider: null,
  endpoint: null,
  endpointClass: null,
  chatModel: null,
  embeddingModel: null,
  hasApiKey: false,
  privacyAcceptedAt: null,
  semanticSearchEnabled: true,
  emotionSuggestionsEnabled: true,
  titleSuggestionsEnabled: true,
  entryHighlightsEnabled: true,
  goDeeperEnabled: true,
  continueWritingEnabled: true,
  dailyChatEnabled: true,
  chatMemoryEnabled: true,
  imageGenerationEnabled: true,
  multiEntrySummaryEnabled: true,
  periodicReviewEnabled: true,
  insightsEnabled: true,
  dashboardInsightsEnabled: false,
  chatRagEnabled: false,
  tagSuggestionsEnabled: true,
  titleSuggestionsSystemPrompt: '',
  entryHighlightsSystemPrompt: '',
  multiEntrySummarySystemPrompt: '',
  goDeeperSystemPrompt: '',
  dailyChatPersona: 'empathetic',
  dailyChatCustomPersona: '',
  dailyChatAiTitle: false,
  responseLanguage: 'auto',
  emotionSuggestionLanguage: 'auto',
  userMemoryEnabled: false,
  personaEnabled: false,
  memoryGenProvider: null,
  memoryGenEndpoint: null,
  memoryGenEndpointClass: null,
  memoryGenChatModel: null,
  memoryGenHasApiKey: false,
  memoryEmbedProvider: null,
  memoryEmbedEndpoint: null,
  memoryEmbedEndpointClass: null,
  memoryEmbedEmbeddingModel: null,
  memoryEmbedHasApiKey: false,
}

function emit<T>(name: string, payload: T) {
  const handler = handlers[name] as Handler<T> | undefined
  if (handler) handler({ payload })
}

const SID = 'session-1'

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(handlers)) delete handlers[k]
  vi.mocked(tauri.dailyChatSendTurn).mockResolvedValue(undefined)
  vi.mocked(tauri.cancelSuggestion).mockResolvedValue(true)
  vi.mocked(tauri.convertChatToEntry).mockResolvedValue({
    markdown: '# Today\n\nA day.',
    throughSeq: 4,
  })
  vi.mocked(tauri.convertChatDeltaToEntry).mockResolvedValue({
    markdown: '## New since last save\n\nMore.',
    throughSeq: 7,
  })
  vi.mocked(tauri.dailyChatMarkConverted).mockResolvedValue(undefined)
  vi.mocked(tauri.dailyChatGenerateTitle).mockResolvedValue(undefined)
  vi.mocked(tauri.getAiSettings).mockResolvedValue(SETTINGS_OFF)
  vi.mocked(tauri.dailyChatLoadSession).mockResolvedValue({
    id: SID,
    title: null,
    persona: 'empathetic',
    language: 'auto',
    createdAt: 0,
    updatedAt: 0,
    messages: [],
    convertedEntryId: null,
    convertedThroughSeq: null,
  })
})

describe('useDailyChat', () => {
  it('starts with no messages and idle turn when sessionId is null', () => {
    const { result } = renderHook(() => useDailyChat(null))
    expect(result.current.messages).toHaveLength(0)
    expect(result.current.turn.kind).toBe('idle')
  })

  it('loads history when sessionId becomes set', async () => {
    vi.mocked(tauri.dailyChatLoadSession).mockResolvedValueOnce({
      id: SID,
      title: 'Past',
      persona: 'empathetic',
      language: 'auto',
      createdAt: 0,
      updatedAt: 0,
      messages: [
        { id: 'm1', role: 'user', content: 'Hi', seq: 0, createdAt: 1_700_000_001 },
        {
          id: 'm2',
          role: 'assistant',
          content: 'Hello.',
          seq: 1,
          createdAt: 1_700_000_002,
          modelId: 'gpt-4o-mini',
          providerId: 'openai',
          endpointClass: 'remote',
          tokensIn: 5,
          tokensOut: 8,
          latencyMs: 100,
        },
      ],
      convertedEntryId: null,
      convertedThroughSeq: null,
    })
    const { result } = renderHook(() => useDailyChat(SID))
    await waitFor(() => expect(result.current.messages).toHaveLength(2))
    expect(result.current.messages[0]).toMatchObject({
      role: 'user',
      content: 'Hi',
      createdAt: 1_700_000_001,
    })
    expect(result.current.messages[1]).toMatchObject({
      role: 'assistant',
      content: 'Hello.',
      createdAt: 1_700_000_002,
    })
    expect(result.current.messages[1].meta?.modelId).toBe('gpt-4o-mini')
    expect(result.current.messages[0].meta).toBeUndefined()
  })

  it('a late history load does not clobber a transcript the user already sent into', async () => {
    // Hold the initial load open so the user can send before it resolves —
    // the fresh-draft race the load guard protects against (a "New chat" the
    // user types into before its not-yet-persisted load settles, or the load
    // racing the backend's lazy create-on-first-send).
    let resolveLoad!: (v: Awaited<ReturnType<typeof tauri.dailyChatLoadSession>>) => void
    vi.mocked(tauri.dailyChatLoadSession).mockReturnValueOnce(
      new Promise((r) => {
        resolveLoad = r
      }),
    )
    const { result } = renderHook(() => useDailyChat(SID))
    await waitFor(() => expect(handlers['ai:daily-chat-token']).toBeDefined())

    await act(async () => {
      await result.current.sendMessage('my very first message')
    })
    expect(result.current.messages).toHaveLength(2) // user + assistant placeholder

    // The initial load now resolves late with unrelated history — it must NOT
    // replace what the user already sent.
    await act(async () => {
      resolveLoad({
        id: SID,
        title: null,
        persona: 'empathetic',
        language: 'auto',
        createdAt: 0,
        updatedAt: 0,
        messages: [{ id: 'old', role: 'assistant', content: 'stale', seq: 0, createdAt: 0 }],
        convertedEntryId: null,
        convertedThroughSeq: null,
      })
      await Promise.resolve()
    })
    expect(result.current.messages).toHaveLength(2)
    expect(result.current.messages[0].content).toBe('my very first message')
  })

  it('a draft (unpersisted) session id renders empty when the load returns not-found', async () => {
    vi.mocked(tauri.dailyChatLoadSession).mockRejectedValueOnce('AI_DAILY_CHAT_SESSION_NOT_FOUND')
    const { result } = renderHook(() => useDailyChat(SID))
    await waitFor(() => expect(tauri.dailyChatLoadSession).toHaveBeenCalled())
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.messages).toHaveLength(0)
    expect(result.current.turn).toEqual({ kind: 'idle' })
  })

  it('sendMessage with no session is a no-op', async () => {
    const { result } = renderHook(() => useDailyChat(null))
    await act(async () => {
      await result.current.sendMessage('hello')
    })
    expect(tauri.dailyChatSendTurn).not.toHaveBeenCalled()
    expect(result.current.messages).toHaveLength(0)
  })

  it('sendMessage appends user + assistant placeholder and flips to streaming', async () => {
    const { result } = renderHook(() => useDailyChat(SID))
    await waitFor(() => expect(handlers['ai:daily-chat-token']).toBeDefined())

    const beforeSec = Math.floor(Date.now() / 1000)
    await act(async () => {
      await result.current.sendMessage('hello there')
    })
    const afterSec = Math.floor(Date.now() / 1000)

    expect(result.current.messages).toHaveLength(2)
    expect(result.current.messages[0].role).toBe('user')
    expect(result.current.messages[0].content).toBe('hello there')
    expect(typeof result.current.messages[0].createdAt).toBe('number')
    expect(result.current.messages[0].createdAt).toBeGreaterThanOrEqual(beforeSec)
    expect(result.current.messages[0].createdAt).toBeLessThanOrEqual(afterSec)
    expect(result.current.messages[1].role).toBe('assistant')
    expect(result.current.messages[1].streaming).toBe(true)
    expect(typeof result.current.messages[1].createdAt).toBe('number')
    expect(result.current.messages[1].createdAt).toBe(result.current.messages[0].createdAt)
    expect(result.current.turn.kind).toBe('streaming')
    expect(tauri.dailyChatSendTurn).toHaveBeenCalledTimes(1)
    const [sid, turnId, userText] = vi.mocked(tauri.dailyChatSendTurn).mock.calls[0]
    expect(sid).toBe(SID)
    expect(typeof turnId).toBe('string')
    expect(userText).toBe('hello there')
  })

  it('ignores empty / whitespace messages', async () => {
    const { result } = renderHook(() => useDailyChat(SID))
    await act(async () => {
      await result.current.sendMessage('   ')
    })
    expect(tauri.dailyChatSendTurn).not.toHaveBeenCalled()
  })

  it('accumulates token deltas into the assistant message', async () => {
    const { result } = renderHook(() => useDailyChat(SID))
    await waitFor(() => expect(handlers['ai:daily-chat-token']).toBeDefined())

    await act(async () => {
      await result.current.sendMessage('Hi')
    })

    if (result.current.turn.kind !== 'streaming') throw new Error('expected streaming')
    const turnId = result.current.turn.turnId

    act(() => {
      emit('ai:daily-chat-token', { key: turnId, delta: 'How ' })
      emit('ai:daily-chat-token', { key: turnId, delta: 'are ' })
      emit('ai:daily-chat-token', { key: turnId, delta: 'you?' })
    })

    expect(result.current.messages[1].content).toBe('How are you?')
  })

  it('flips to idle on complete with the final content', async () => {
    const { result } = renderHook(() => useDailyChat(SID))
    await waitFor(() => expect(handlers['ai:daily-chat-token']).toBeDefined())

    await act(async () => {
      await result.current.sendMessage('Hi')
    })
    if (result.current.turn.kind !== 'streaming') throw new Error('expected streaming')
    const turnId = result.current.turn.turnId

    act(() => {
      emit('ai:daily-chat-complete', {
        key: turnId,
        content: 'Hello!',
        modelId: 'llama3',
        providerId: 'ollama',
        endpointClass: 'local',
        tokensIn: 12,
        tokensOut: 34,
        latencyMs: 250,
      })
    })

    expect(result.current.messages[1].content).toBe('Hello!')
    expect(result.current.messages[1].streaming).toBeFalsy()
    expect(result.current.messages[1].meta?.modelId).toBe('llama3')
    expect(result.current.messages[1].meta?.providerId).toBe('ollama')
    expect(result.current.messages[1].meta?.tokensIn).toBe(12)
    expect(result.current.turn.kind).toBe('idle')
  })

  it('stale token from a different turnId is ignored', async () => {
    const { result } = renderHook(() => useDailyChat(SID))
    await waitFor(() => expect(handlers['ai:daily-chat-token']).toBeDefined())

    await act(async () => {
      await result.current.sendMessage('Hi')
    })

    act(() => {
      emit('ai:daily-chat-token', { key: 'turn-other', delta: 'noise' })
    })

    expect(result.current.messages[1].content).toBe('')
  })

  it('flips to error on backend error event', async () => {
    const { result } = renderHook(() => useDailyChat(SID))
    await waitFor(() => expect(handlers['ai:daily-chat-error']).toBeDefined())

    await act(async () => {
      await result.current.sendMessage('Hi')
    })
    if (result.current.turn.kind !== 'streaming') throw new Error('expected streaming')
    const turnId = result.current.turn.turnId

    act(() => {
      emit('ai:daily-chat-error', { key: turnId, code: 'AI_RATE_LIMITED' })
    })

    const errorTurn = result.current.turn as TurnState
    if (errorTurn.kind !== 'error') throw new Error('expected error')
    expect(errorTurn.code).toBe('AI_RATE_LIMITED')
    expect(result.current.messages[1].errorCode).toBe('AI_RATE_LIMITED')
  })

  it('cancelTurn drops the placeholder, flips idle, and calls backend cancel', async () => {
    const { result } = renderHook(() => useDailyChat(SID))
    await waitFor(() => expect(handlers['ai:daily-chat-token']).toBeDefined())

    await act(async () => {
      await result.current.sendMessage('Hi')
    })
    if (result.current.turn.kind !== 'streaming') throw new Error('expected streaming')
    const turnId = result.current.turn.turnId

    await act(async () => {
      await result.current.cancelTurn()
    })

    expect(result.current.messages).toHaveLength(1)
    expect(result.current.messages[0].role).toBe('user')
    expect(result.current.turn.kind).toBe('idle')
    expect(tauri.cancelSuggestion).toHaveBeenCalledWith(`daily-chat:${turnId}`)
  })

  it('reset wipes everything (messages, turn, and conversion state)', async () => {
    // Load a session that already has a conversion watermark so we can
    // assert reset clears it too — switching sessions must not leak
    // "this chat was saved as entry X" onto an unrelated fresh session.
    vi.mocked(tauri.dailyChatLoadSession).mockResolvedValueOnce({
      id: SID,
      title: 'Past',
      persona: 'empathetic',
      language: 'auto',
      createdAt: 0,
      updatedAt: 0,
      messages: [
        { id: 'm1', role: 'user', content: 'Hi', seq: 0, createdAt: 1 },
        { id: 'm2', role: 'assistant', content: 'Hello.', seq: 5, createdAt: 2 },
      ],
      convertedEntryId: 'entry-1',
      convertedThroughSeq: 3,
    })
    const { result } = renderHook(() => useDailyChat(SID))
    await waitFor(() => expect(result.current.messages).toHaveLength(2))
    expect(result.current.convertedEntryId).toBe('entry-1')
    expect(result.current.convertedThroughSeq).toBe(3)
    expect(result.current.newSinceConversion).toBe(true)

    act(() => {
      result.current.reset()
    })

    expect(result.current.messages).toHaveLength(0)
    expect(result.current.turn.kind).toBe('idle')
    expect(result.current.convertedEntryId).toBeNull()
    expect(result.current.convertedThroughSeq).toBeNull()
    expect(result.current.newSinceConversion).toBe(false)
  })

  it('convertToEntry forwards the session id to the backend', async () => {
    const { result } = renderHook(() => useDailyChat(SID))
    await waitFor(() => expect(handlers['ai:daily-chat-token']).toBeDefined())

    let res: { markdown: string; throughSeq: number } = { markdown: '', throughSeq: -1 }
    await act(async () => {
      res = await result.current.convertToEntry()
    })

    expect(res).toEqual({ markdown: '# Today\n\nA day.', throughSeq: 4 })
    expect(tauri.convertChatToEntry).toHaveBeenCalledWith(SID)
  })

  it('convertDelta calls convertChatDeltaToEntry and returns the { markdown, throughSeq } result', async () => {
    const { result } = renderHook(() => useDailyChat(SID))
    await waitFor(() => expect(handlers['ai:daily-chat-token']).toBeDefined())

    let res: { markdown: string; throughSeq: number } = { markdown: '', throughSeq: -1 }
    await act(async () => {
      res = await result.current.convertDelta()
    })

    expect(res).toEqual({ markdown: '## New since last save\n\nMore.', throughSeq: 7 })
    expect(tauri.convertChatDeltaToEntry).toHaveBeenCalledWith(SID)
  })

  it('marks newSinceConversion true when a loaded assistant seq is above convertedThroughSeq', async () => {
    vi.mocked(tauri.dailyChatLoadSession).mockResolvedValueOnce({
      id: SID,
      title: 'Past',
      persona: 'empathetic',
      language: 'auto',
      createdAt: 0,
      updatedAt: 0,
      messages: [
        { id: 'm1', role: 'user', content: 'Hi', seq: 0, createdAt: 1 },
        { id: 'm2', role: 'assistant', content: 'Hello.', seq: 5, createdAt: 2 },
      ],
      convertedEntryId: 'entry-1',
      convertedThroughSeq: 3,
    })
    const { result } = renderHook(() => useDailyChat(SID))
    await waitFor(() => expect(result.current.messages).toHaveLength(2))

    expect(result.current.convertedEntryId).toBe('entry-1')
    expect(result.current.convertedThroughSeq).toBe(3)
    expect(result.current.newSinceConversion).toBe(true)
  })

  it('marks newSinceConversion false when the last assistant seq is at or below convertedThroughSeq', async () => {
    vi.mocked(tauri.dailyChatLoadSession).mockResolvedValueOnce({
      id: SID,
      title: 'Past',
      persona: 'empathetic',
      language: 'auto',
      createdAt: 0,
      updatedAt: 0,
      messages: [
        { id: 'm1', role: 'user', content: 'Hi', seq: 0, createdAt: 1 },
        { id: 'm2', role: 'assistant', content: 'Hello.', seq: 5, createdAt: 2 },
      ],
      convertedEntryId: 'entry-1',
      convertedThroughSeq: 5,
    })
    const { result } = renderHook(() => useDailyChat(SID))
    await waitFor(() => expect(result.current.messages).toHaveLength(2))

    expect(result.current.convertedEntryId).toBe('entry-1')
    expect(result.current.convertedThroughSeq).toBe(5)
    expect(result.current.newSinceConversion).toBe(false)
  })

  it('marks newSinceConversion false when convertedEntryId is null regardless of messages', async () => {
    vi.mocked(tauri.dailyChatLoadSession).mockResolvedValueOnce({
      id: SID,
      title: 'Past',
      persona: 'empathetic',
      language: 'auto',
      createdAt: 0,
      updatedAt: 0,
      messages: [
        { id: 'm1', role: 'user', content: 'Hi', seq: 0, createdAt: 1 },
        { id: 'm2', role: 'assistant', content: 'Hello.', seq: 5, createdAt: 2 },
      ],
      convertedEntryId: null,
      convertedThroughSeq: null,
    })
    const { result } = renderHook(() => useDailyChat(SID))
    await waitFor(() => expect(result.current.messages).toHaveLength(2))

    expect(result.current.convertedEntryId).toBeNull()
    expect(result.current.convertedThroughSeq).toBeNull()
    expect(result.current.newSinceConversion).toBe(false)
  })

  it('markConverted calls the backend and flips local conversion state', async () => {
    // Start with a converted session that has new content.
    vi.mocked(tauri.dailyChatLoadSession).mockResolvedValueOnce({
      id: SID,
      title: 'Past',
      persona: 'empathetic',
      language: 'auto',
      createdAt: 0,
      updatedAt: 0,
      messages: [{ id: 'm1', role: 'assistant', content: 'Hello.', seq: 8, createdAt: 2 }],
      convertedEntryId: 'entry-old',
      convertedThroughSeq: 3,
    })
    const { result } = renderHook(() => useDailyChat(SID))
    await waitFor(() => expect(result.current.messages).toHaveLength(1))
    expect(result.current.newSinceConversion).toBe(true)

    await act(async () => {
      await result.current.markConverted('e1', 5)
    })

    expect(tauri.dailyChatMarkConverted).toHaveBeenCalledWith(SID, 'e1', 5)
    expect(result.current.convertedEntryId).toBe('e1')
    expect(result.current.convertedThroughSeq).toBe(5)
    expect(result.current.newSinceConversion).toBe(false)
  })

  it('does not fire LLM title-gen when dailyChatAiTitle is off (default)', async () => {
    const { result } = renderHook(() => useDailyChat(SID))
    await waitFor(() => expect(handlers['ai:daily-chat-token']).toBeDefined())

    await act(async () => {
      await result.current.sendMessage('Today was a really long and rough day')
    })

    expect(tauri.getAiSettings).toHaveBeenCalled()
    expect(tauri.dailyChatGenerateTitle).not.toHaveBeenCalled()
  })

  it('fires LLM title-gen on first user reply when dailyChatAiTitle is on and ≥15 chars', async () => {
    vi.mocked(tauri.getAiSettings).mockResolvedValue({
      ...SETTINGS_OFF,
      dailyChatAiTitle: true,
    })
    const { result } = renderHook(() => useDailyChat(SID))
    await waitFor(() => expect(handlers['ai:daily-chat-token']).toBeDefined())

    await act(async () => {
      await result.current.sendMessage('Today was a really long and rough day')
    })

    await waitFor(() => {
      expect(tauri.dailyChatGenerateTitle).toHaveBeenCalledWith(SID)
    })
  })

  it('skips LLM title-gen on short first reply even when ai title is on', async () => {
    vi.mocked(tauri.getAiSettings).mockResolvedValue({
      ...SETTINGS_OFF,
      dailyChatAiTitle: true,
    })
    const { result } = renderHook(() => useDailyChat(SID))
    await waitFor(() => expect(handlers['ai:daily-chat-token']).toBeDefined())

    await act(async () => {
      await result.current.sendMessage('ok')
    })

    expect(tauri.dailyChatGenerateTitle).not.toHaveBeenCalled()
  })

  it('does not fire title-gen on a second user reply', async () => {
    vi.mocked(tauri.getAiSettings).mockResolvedValue({
      ...SETTINGS_OFF,
      dailyChatAiTitle: true,
    })
    // Pre-load history so the first user message already exists.
    vi.mocked(tauri.dailyChatLoadSession).mockResolvedValueOnce({
      id: SID,
      title: 'Past',
      persona: 'empathetic',
      language: 'auto',
      createdAt: 0,
      updatedAt: 0,
      messages: [
        { id: 'm1', role: 'assistant', content: 'opener', seq: 0, createdAt: 0 },
        { id: 'm2', role: 'user', content: 'first reply', seq: 1, createdAt: 0 },
      ],
      convertedEntryId: null,
      convertedThroughSeq: null,
    })
    const { result } = renderHook(() => useDailyChat(SID))
    await waitFor(() => expect(result.current.messages.length).toBeGreaterThan(0))

    await act(async () => {
      await result.current.sendMessage('My second longer message goes here')
    })

    expect(tauri.dailyChatGenerateTitle).not.toHaveBeenCalled()
  })

  it('double-send while streaming is rejected', async () => {
    const { result } = renderHook(() => useDailyChat(SID))
    await waitFor(() => expect(handlers['ai:daily-chat-token']).toBeDefined())

    await act(async () => {
      await result.current.sendMessage('first')
    })
    await act(async () => {
      await result.current.sendMessage('second')
    })

    expect(tauri.dailyChatSendTurn).toHaveBeenCalledTimes(1)
    expect(result.current.messages).toHaveLength(2)
  })

  it('sendMessage_forwards_attachments_to_backend', async () => {
    const { result } = renderHook(() => useDailyChat(SID))
    await waitFor(() => expect(handlers['ai:daily-chat-token']).toBeDefined())

    const attachments: ChatAttachmentRef[] = [{ kind: 'entry', id: 'e1' }]
    await act(async () => {
      await result.current.sendMessage('hello', attachments, false)
    })

    expect(tauri.dailyChatSendTurn).toHaveBeenCalledWith(
      SID,
      expect.any(String),
      'hello',
      attachments,
      false,
    )
  })

  it('sendMessage_defaults_oversize_confirmed_to_false', async () => {
    const { result } = renderHook(() => useDailyChat(SID))
    await waitFor(() => expect(handlers['ai:daily-chat-token']).toBeDefined())

    await act(async () => {
      await result.current.sendMessage('hello')
    })

    expect(tauri.dailyChatSendTurn).toHaveBeenCalledWith(
      SID,
      expect.any(String),
      'hello',
      [],
      false,
    )
  })

  it('complete_event_populates_source_entry_ids', async () => {
    const { result } = renderHook(() => useDailyChat(SID))
    await waitFor(() => expect(handlers['ai:daily-chat-token']).toBeDefined())

    await act(async () => {
      await result.current.sendMessage('Hi')
    })
    if (result.current.turn.kind !== 'streaming') throw new Error('expected streaming')
    const turnId = result.current.turn.turnId

    act(() => {
      emit('ai:daily-chat-complete', {
        key: turnId,
        content: 'Hello!',
        sourceEntryIds: ['e1', 'e2'],
        memoriesUsed: [{ id: 'mem-1', text: 'User likes hiking' }],
      })
    })

    expect(result.current.messages[1].sourceEntryIds).toEqual(['e1', 'e2'])
    // Persisted onto THIS message, not a separate session-level field — the
    // regression this bug fix addresses (the old `lastMemoriesUsed` state
    // vanished on the next turn / reload; the id list on the message survives).
    expect(result.current.messages[1].memoryIds).toEqual(['mem-1'])
  })

  it('load_populates_attachments_on_user_messages', async () => {
    vi.mocked(tauri.dailyChatLoadSession).mockResolvedValueOnce({
      id: SID,
      title: null,
      persona: 'empathetic',
      language: 'auto',
      createdAt: 0,
      updatedAt: 0,
      messages: [
        {
          id: 'm1',
          role: 'user',
          content: 'Hi',
          seq: 0,
          createdAt: 1,
          attachments: [{ kind: 'entry', id: 'e1' }],
        },
        {
          id: 'm2',
          role: 'assistant',
          content: 'Hello',
          seq: 1,
          createdAt: 2,
          sourceEntryIds: ['e1'],
          memoryIds: ['mem-1'],
        },
      ],
      convertedEntryId: null,
      convertedThroughSeq: null,
    })

    const { result } = renderHook(() => useDailyChat(SID))
    await waitFor(() => expect(result.current.messages).toHaveLength(2))

    expect(result.current.messages[0].attachments).toEqual([{ kind: 'entry', id: 'e1' }])
    expect(result.current.messages[1].sourceEntryIds).toEqual(['e1'])
    // Reload path: the chip must be driven by the persisted row, not by any
    // in-memory turn state — this is what makes it survive a reload.
    expect(result.current.messages[1].memoryIds).toEqual(['mem-1'])
  })

  it('period_too_large_refusal_maps_to_refusal_state_not_generic_error', async () => {
    const refusal = { code: 'period_too_large', label: 'July 2026', entryCount: 87 }
    vi.mocked(tauri.dailyChatSendTurn).mockRejectedValueOnce(JSON.stringify(refusal))

    const { result } = renderHook(() => useDailyChat(SID))
    await waitFor(() => expect(handlers['ai:daily-chat-token']).toBeDefined())

    await act(async () => {
      await result.current.sendMessage('hello')
    })

    expect(result.current.refusal).toEqual(refusal)
    expect(result.current.turn.kind).toBe('idle')
  })

  it('needs_confirmation_refusal_is_exposed_with_its_numbers', async () => {
    const refusal = {
      code: 'needs_confirmation',
      label: 'July 2026',
      estimatedBytes: 9000,
      entriesIncluded: 6,
      entriesTotal: 87,
      totalBytes: 340000,
    }
    vi.mocked(tauri.dailyChatSendTurn).mockRejectedValueOnce(JSON.stringify(refusal))

    const { result } = renderHook(() => useDailyChat(SID))
    await waitFor(() => expect(handlers['ai:daily-chat-token']).toBeDefined())

    await act(async () => {
      await result.current.sendMessage('hello')
    })

    expect(result.current.refusal).toEqual(refusal)
  })

  it('confirming_resends_the_same_turn_with_oversize_confirmed_true', async () => {
    const refusal = {
      code: 'needs_confirmation',
      label: null,
      estimatedBytes: 9000,
      entriesIncluded: 6,
      entriesTotal: 87,
      totalBytes: 340000,
    }
    vi.mocked(tauri.dailyChatSendTurn).mockRejectedValueOnce(JSON.stringify(refusal))
    vi.mocked(tauri.dailyChatSendTurn).mockResolvedValueOnce(undefined)

    const { result } = renderHook(() => useDailyChat(SID))
    await waitFor(() => expect(handlers['ai:daily-chat-token']).toBeDefined())

    const attachments: ChatAttachmentRef[] = [{ kind: 'period', start: 1, end: 2, label: 'July' }]
    await act(async () => {
      await result.current.sendMessage('hello', attachments, false)
    })
    expect(result.current.refusal).toEqual(refusal)

    await act(async () => {
      await result.current.sendMessage('hello', attachments, true)
    })

    expect(tauri.dailyChatSendTurn).toHaveBeenLastCalledWith(
      SID,
      expect.any(String),
      'hello',
      attachments,
      true,
    )
    expect(result.current.turn.kind).toBe('streaming')
  })

  it('refused_send_drops_both_optimistic_rows', async () => {
    // A refusal returns before `daily_chat_send_turn_inner`'s first write, so
    // NOTHING is persisted server-side — the transcript must mirror that and
    // drop the user bubble as well as the assistant placeholder. Keeping the
    // user bubble is what produced a duplicate question on confirm-and-resend.
    // The attachments are not lost: `ChatConversation` owns them.
    const refusal = { code: 'period_too_large', label: 'July 2026', entryCount: 87 }
    vi.mocked(tauri.dailyChatSendTurn).mockRejectedValueOnce(JSON.stringify(refusal))

    const { result } = renderHook(() => useDailyChat(SID))
    await waitFor(() => expect(handlers['ai:daily-chat-token']).toBeDefined())

    const attachments: ChatAttachmentRef[] = [{ kind: 'period', start: 1, end: 2, label: 'July' }]
    await act(async () => {
      await result.current.sendMessage('hello', attachments)
    })

    expect(result.current.messages).toHaveLength(0)
    expect(result.current.refusal).toEqual(refusal)
  })

  it('confirming_a_refusal_does_not_duplicate_the_user_message', async () => {
    // The regression guard for the confirm-and-resend duplicate: refuse once,
    // then let the replay succeed, and assert exactly ONE user bubble exists.
    const refusal = {
      code: 'needs_confirmation',
      label: 'July 2026',
      estimatedBytes: 20_000,
      entriesIncluded: 6,
      entriesTotal: 87,
      totalBytes: 340_000,
    }
    vi.mocked(tauri.dailyChatSendTurn).mockRejectedValueOnce(JSON.stringify(refusal))

    const { result } = renderHook(() => useDailyChat(SID))
    await waitFor(() => expect(handlers['ai:daily-chat-token']).toBeDefined())

    await act(async () => {
      await result.current.sendMessage('hello', [])
    })
    expect(result.current.refusal).toMatchObject({ code: 'needs_confirmation' })

    vi.mocked(tauri.dailyChatSendTurn).mockResolvedValueOnce(undefined)
    await act(async () => {
      await result.current.sendMessage('hello', [], true)
    })

    const userMessages = result.current.messages.filter((m) => m.role === 'user')
    expect(userMessages).toHaveLength(1)
    expect(userMessages[0].content).toBe('hello')
  })

  it('malformed_refusal_json_falls_back_to_generic_error', async () => {
    vi.mocked(tauri.dailyChatSendTurn).mockRejectedValueOnce('AI_NOT_CONFIGURED')

    const { result } = renderHook(() => useDailyChat(SID))
    await waitFor(() => expect(handlers['ai:daily-chat-token']).toBeDefined())

    await act(async () => {
      await result.current.sendMessage('hello')
    })

    expect(result.current.refusal).toBeNull()
    const turn = result.current.turn
    if (turn.kind !== 'error') throw new Error('expected error')
    expect(turn.code).toBe('AI_NOT_CONFIGURED')
  })

  it('unwraps a feature-disabled code carried inside AI_PROVIDER_ERROR', async () => {
    vi.mocked(tauri.dailyChatSendTurn).mockRejectedValueOnce(
      'AI_PROVIDER_ERROR: AI_DAILY_CHAT_DISABLED',
    )

    const { result } = renderHook(() => useDailyChat(SID))
    await waitFor(() => expect(handlers['ai:daily-chat-token']).toBeDefined())

    await act(async () => {
      await result.current.sendMessage('hello')
    })

    expect(result.current.refusal).toBeNull()
    const turn = result.current.turn
    if (turn.kind !== 'error') throw new Error('expected error')
    expect(turn.code).toBe('AI_DAILY_CHAT_DISABLED')
  })
})
