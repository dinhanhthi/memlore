import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useCallback, useEffect } from 'react'
import { getEmbeddingSyncDecisions, resolveEmbeddingSyncDecision } from '../lib/tauri'
import { useEmbeddingStatusStore } from '../stores/embeddingStatusStore'
import type {
  EmbedPauseScope,
  EmbedSyncDecisionAction,
  EmbedSyncDecisionSlotView,
  EmbedSyncSlot,
  EmbeddingDecisionNeededEvent,
  ResolveEmbeddingSyncDecisionResult,
} from '../types/ai'

/** Modal Pause persists this scope. Absent on old receipts → `all`. */
export const EMBED_MODAL_PAUSE_SCOPE: EmbedPauseScope = 'sync_backfill'

/**
 * Embedding sync decision hook — listens for `ai:embedding-decision-needed`,
 * hydrates decision snapshots on mount, and auto-opens the modal when any
 * slot is freshly `pending`.
 *
 * Dismiss without choosing re-embed/switch resolves `pause` for each
 * pending slot so the gate stays intentional and the footer chip remains
 * available (backend `needs_modal` is true for both pending and pause).
 *
 * Mount once from `EmbeddingSyncDecisionModal` (App shell when unlocked).
 * State lives in `useEmbeddingStatusStore` so the footer chip can re-open
 * without owning its own IPC subscription.
 */
export function useEmbeddingSyncDecision() {
  const decisionSlots = useEmbeddingStatusStore((s) => s.decisionSlots)
  const decisionModalOpen = useEmbeddingStatusStore((s) => s.decisionModalOpen)
  const setDecisionSlots = useEmbeddingStatusStore((s) => s.setDecisionSlots)
  const setDecisionModalOpen = useEmbeddingStatusStore((s) => s.setDecisionModalOpen)

  const applySlots = useCallback(
    (slots: EmbedSyncDecisionSlotView[], openIfPending: boolean) => {
      setDecisionSlots(slots)
      if (openIfPending && slots.some((s) => s.state === 'pending')) {
        setDecisionModalOpen(true)
      }
      // Close only when nothing still needs attention (pending or pause).
      if (!slots.some((s) => s.needsModal)) {
        setDecisionModalOpen(false)
      }
    },
    [setDecisionSlots, setDecisionModalOpen],
  )

  const refreshDecisions = useCallback(async () => {
    try {
      const resp = await getEmbeddingSyncDecisions()
      const slots = resp?.slots ?? []
      // Mount/manual refresh: only auto-open for fresh pending (not pause
      // re-entry — that is chip-driven).
      applySlots(slots, true)
      return slots
    } catch (e) {
      console.warn('useEmbeddingSyncDecision: refresh failed', e)
      return useEmbeddingStatusStore.getState().decisionSlots
    }
  }, [applySlots])

  useEffect(() => {
    void refreshDecisions()
  }, [refreshDecisions])

  useEffect(() => {
    const unlisteners: UnlistenFn[] = []
    let cancelled = false

    async function subscribe() {
      try {
        const un = await listen<EmbeddingDecisionNeededEvent>(
          'ai:embedding-decision-needed',
          (event) => {
            const slots = event.payload?.slots ?? []
            applySlots(slots, true)
          },
        )
        unlisteners.push(un)
        if (cancelled) un()
      } catch (e) {
        console.warn('useEmbeddingSyncDecision: subscribe failed', e)
      }
    }

    void subscribe()
    return () => {
      cancelled = true
      for (const u of unlisteners) u()
    }
  }, [applySlots])

  const resolve = useCallback(
    async (
      slot: EmbedSyncSlot | string,
      action: EmbedSyncDecisionAction,
      targetModelId?: string,
    ): Promise<ResolveEmbeddingSyncDecisionResult> => {
      const result = await resolveEmbeddingSyncDecision({
        slot,
        action,
        ...(targetModelId != null && targetModelId !== '' ? { targetModelId } : {}),
        ...(action === 'pause' ? { pauseScope: EMBED_MODAL_PAUSE_SCOPE } : {}),
      })
      // Always re-fetch both slots after resolve — switch may leave needs_key
      // pending on the same slot, and dual-slot state can change together.
      await refreshDecisions()
      return result
    },
    [refreshDecisions],
  )

  /**
   * Esc / Close / "Pause all": pause every currently pending slot with
   * `pause_scope=sync_backfill` (new local edits keep indexing), then
   * hide the modal. Already-paused slots keep their pause receipt (chip
   * re-opens the modal without re-writing).
   */
  const dismissWithPause = useCallback(async () => {
    const pending = useEmbeddingStatusStore
      .getState()
      .decisionSlots.filter((s) => s.state === 'pending')
    for (const s of pending) {
      try {
        await resolveEmbeddingSyncDecision({
          slot: s.slot,
          action: 'pause',
          pauseScope: EMBED_MODAL_PAUSE_SCOPE,
        })
      } catch (e) {
        console.warn('useEmbeddingSyncDecision: pause on dismiss failed', e)
      }
    }
    await refreshDecisions()
    setDecisionModalOpen(false)
  }, [refreshDecisions, setDecisionModalOpen])

  const openModal = useCallback(() => {
    setDecisionModalOpen(true)
  }, [setDecisionModalOpen])

  const closeModal = useCallback(() => {
    setDecisionModalOpen(false)
  }, [setDecisionModalOpen])

  return {
    decisionSlots,
    decisionModalOpen,
    refreshDecisions,
    resolve,
    dismissWithPause,
    openModal,
    closeModal,
    setDecisionModalOpen,
  }
}
