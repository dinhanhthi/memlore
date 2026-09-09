import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetEmbeddingStatusStoreForTests } from '../stores/embeddingStatusStore'
import type {
  EmbedSyncDecisionSlotView,
  EmbeddingDecisionNeededEvent,
  EmbeddingSyncDecisionsResponse,
} from '../types/ai'
import { EMBED_MODAL_PAUSE_SCOPE, useEmbeddingSyncDecision } from './useEmbeddingSyncDecision'

type Handler = (event: { payload: unknown }) => void
const handlers: Record<string, Handler> = {}

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: Handler) => {
    handlers[name] = handler
    return () => {
      delete handlers[name]
    }
  }),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

vi.mock('../lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('../lib/tauri')>('../lib/tauri')
  return {
    ...actual,
    getEmbeddingSyncDecisions: vi.fn(),
    resolveEmbeddingSyncDecision: vi.fn(),
  }
})

import * as tauri from '../lib/tauri'

const pendingEntry = (
  overrides: Partial<EmbedSyncDecisionSlotView> = {},
): EmbedSyncDecisionSlotView => ({
  slot: 'entry',
  state: 'pending',
  reason: 'model_mismatch',
  localModelId: 'openai:text-embedding-3-small',
  peerModels: [{ modelId: 'ollama:nomic-embed-text', count: 2 }],
  pendingUnits: 2,
  needsModal: true,
  ...overrides,
})

const noneSlot = (slot: 'entry' | 'memory'): EmbedSyncDecisionSlotView => ({
  slot,
  state: 'none',
  reason: null,
  localModelId: null,
  peerModels: [],
  pendingUnits: 0,
  needsModal: false,
})

const fireDecisionNeeded = (payload: EmbeddingDecisionNeededEvent) => {
  handlers['ai:embedding-decision-needed']?.({ payload })
}

beforeEach(() => {
  vi.resetAllMocks()
  for (const k of Object.keys(handlers)) delete handlers[k]
  __resetEmbeddingStatusStoreForTests()
  vi.mocked(tauri.getEmbeddingSyncDecisions).mockResolvedValue({
    slots: [noneSlot('entry'), noneSlot('memory')],
    needsModal: false,
  })
  vi.mocked(tauri.resolveEmbeddingSyncDecision).mockResolvedValue({
    ok: true,
    nextState: 'pause',
    needsKey: false,
  })
})

describe('useEmbeddingSyncDecision', () => {
  it('hydrates decision slots from getEmbeddingSyncDecisions on mount', async () => {
    const slots = [pendingEntry(), noneSlot('memory')]
    vi.mocked(tauri.getEmbeddingSyncDecisions).mockResolvedValue({
      slots,
      needsModal: true,
    })

    const { result } = renderHook(() => useEmbeddingSyncDecision())

    await waitFor(() => expect(result.current.decisionSlots).toEqual(slots))
    expect(result.current.decisionModalOpen).toBe(true)
  })

  it('does not auto-open for pause-only slots on mount (chip re-opens)', async () => {
    const slots: EmbedSyncDecisionSlotView[] = [
      {
        slot: 'entry',
        state: 'pause',
        reason: 'model_mismatch',
        localModelId: 'm',
        peerModels: [],
        pendingUnits: 0,
        needsModal: true,
      },
      noneSlot('memory'),
    ]
    vi.mocked(tauri.getEmbeddingSyncDecisions).mockResolvedValue({
      slots,
      needsModal: true,
    })

    const { result } = renderHook(() => useEmbeddingSyncDecision())

    await waitFor(() => expect(result.current.decisionSlots).toEqual(slots))
    expect(result.current.decisionModalOpen).toBe(false)
  })

  it('opens the modal when ai:embedding-decision-needed carries a pending slot', async () => {
    const { result } = renderHook(() => useEmbeddingSyncDecision())
    await waitFor(() => expect(tauri.getEmbeddingSyncDecisions).toHaveBeenCalledTimes(1))

    const slots = [pendingEntry({ slot: 'memory' }), noneSlot('entry')]
    act(() => {
      fireDecisionNeeded({ slots })
    })

    expect(result.current.decisionSlots).toEqual(slots)
    expect(result.current.decisionModalOpen).toBe(true)
  })

  it('dismissWithPause resolves pause for each pending slot then closes', async () => {
    const slots = [
      pendingEntry({ slot: 'entry' }),
      pendingEntry({ slot: 'memory', reason: 'missing_key', peerModels: [] }),
    ]
    vi.mocked(tauri.getEmbeddingSyncDecisions)
      .mockResolvedValueOnce({ slots, needsModal: true })
      .mockResolvedValue({
        slots: [
          { ...slots[0], state: 'pause', needsModal: true },
          { ...slots[1], state: 'pause', needsModal: true },
        ],
        needsModal: true,
      } satisfies EmbeddingSyncDecisionsResponse)

    const { result } = renderHook(() => useEmbeddingSyncDecision())
    await waitFor(() => expect(result.current.decisionModalOpen).toBe(true))

    await act(async () => {
      await result.current.dismissWithPause()
    })

    expect(EMBED_MODAL_PAUSE_SCOPE).toBe('sync_backfill')
    expect(tauri.resolveEmbeddingSyncDecision).toHaveBeenCalledTimes(2)
    expect(tauri.resolveEmbeddingSyncDecision).toHaveBeenCalledWith({
      slot: 'entry',
      action: 'pause',
      pauseScope: 'sync_backfill',
    })
    expect(tauri.resolveEmbeddingSyncDecision).toHaveBeenCalledWith({
      slot: 'memory',
      action: 'pause',
      pauseScope: 'sync_backfill',
    })
    expect(result.current.decisionModalOpen).toBe(false)
  })

  it('resolve pause writes sync_backfill so new local edits keep indexing', async () => {
    vi.mocked(tauri.getEmbeddingSyncDecisions)
      .mockResolvedValueOnce({
        slots: [pendingEntry(), noneSlot('memory')],
        needsModal: true,
      })
      .mockResolvedValue({
        slots: [
          {
            ...pendingEntry(),
            state: 'pause',
            needsModal: true,
          },
          noneSlot('memory'),
        ],
        needsModal: true,
      })

    const { result } = renderHook(() => useEmbeddingSyncDecision())
    await waitFor(() => expect(result.current.decisionModalOpen).toBe(true))

    await act(async () => {
      await result.current.resolve('entry', 'pause')
    })

    expect(tauri.resolveEmbeddingSyncDecision).toHaveBeenCalledWith({
      slot: 'entry',
      action: 'pause',
      pauseScope: 'sync_backfill',
    })
  })

  it('resolve invokes IPC with optional targetModelId and refreshes', async () => {
    vi.mocked(tauri.resolveEmbeddingSyncDecision).mockResolvedValue({
      ok: true,
      nextState: 'switch',
      needsKey: false,
    })
    vi.mocked(tauri.getEmbeddingSyncDecisions)
      .mockResolvedValueOnce({
        slots: [pendingEntry(), noneSlot('memory')],
        needsModal: true,
      })
      .mockResolvedValue({
        slots: [noneSlot('entry'), noneSlot('memory')],
        needsModal: false,
      })

    const { result } = renderHook(() => useEmbeddingSyncDecision())
    await waitFor(() => expect(result.current.decisionModalOpen).toBe(true))

    let res: Awaited<ReturnType<typeof result.current.resolve>> | undefined
    await act(async () => {
      res = await result.current.resolve('entry', 'switch', 'ollama:nomic-embed-text')
    })

    expect(tauri.resolveEmbeddingSyncDecision).toHaveBeenCalledWith({
      slot: 'entry',
      action: 'switch',
      targetModelId: 'ollama:nomic-embed-text',
    })
    expect(res?.ok).toBe(true)
    await waitFor(() => expect(result.current.decisionModalOpen).toBe(false))
  })

  it('subscribes to ai:embedding-decision-needed and unlistens on unmount', async () => {
    const { unmount } = renderHook(() => useEmbeddingSyncDecision())

    await waitFor(() => expect(Object.keys(handlers)).toEqual(['ai:embedding-decision-needed']))

    unmount()
    expect(Object.keys(handlers)).toEqual([])
  })

  it('tolerates null getEmbeddingSyncDecisions payload', async () => {
    vi.mocked(tauri.getEmbeddingSyncDecisions).mockResolvedValue(
      null as unknown as EmbeddingSyncDecisionsResponse,
    )

    const { result } = renderHook(() => useEmbeddingSyncDecision())

    await waitFor(() => expect(tauri.getEmbeddingSyncDecisions).toHaveBeenCalledTimes(1))
    expect(result.current.decisionSlots).toEqual([])
    expect(result.current.decisionModalOpen).toBe(false)
  })

  it('resolves one slot independently without clearing the other pending slot', async () => {
    const entryPending = pendingEntry({ slot: 'entry' })
    const memoryPending = pendingEntry({
      slot: 'memory',
      reason: 'model_mismatch',
      peerModels: [{ modelId: 'peer:mem', count: 1 }],
      pendingUnits: 1,
    })
    const afterEntryReembed: EmbedSyncDecisionSlotView[] = [
      {
        ...entryPending,
        state: 'reembed',
        needsModal: false,
        pendingUnits: 0,
        peerModels: [],
      },
      memoryPending,
    ]

    vi.mocked(tauri.getEmbeddingSyncDecisions)
      .mockResolvedValueOnce({
        slots: [entryPending, memoryPending],
        needsModal: true,
      })
      .mockResolvedValue({
        slots: afterEntryReembed,
        needsModal: true,
      })
    vi.mocked(tauri.resolveEmbeddingSyncDecision).mockResolvedValue({
      ok: true,
      nextState: 'reembed',
      needsKey: false,
    })

    const { result } = renderHook(() => useEmbeddingSyncDecision())
    await waitFor(() => expect(result.current.decisionModalOpen).toBe(true))

    await act(async () => {
      await result.current.resolve('entry', 'reembed')
    })

    expect(tauri.resolveEmbeddingSyncDecision).toHaveBeenCalledTimes(1)
    expect(tauri.resolveEmbeddingSyncDecision).toHaveBeenCalledWith({
      slot: 'entry',
      action: 'reembed',
    })
    await waitFor(() => {
      expect(result.current.decisionSlots).toEqual(afterEntryReembed)
    })
    // Modal stays open while the other slot still needs a decision.
    expect(result.current.decisionModalOpen).toBe(true)
    expect(result.current.decisionSlots.find((s) => s.slot === 'memory')?.state).toBe('pending')
  })
})
