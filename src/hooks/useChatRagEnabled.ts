import { useCallback, useEffect } from 'react'
import { extractAiErrorCode } from '../lib/aiErrorCode'
import { setAiFeature } from '../lib/tauri'
import { useAiSettingsStore } from '../stores/aiSettingsStore'

export interface UseChatRagEnabledReturn {
  /** `null` while the store has not hydrated yet — same convention as the
   *  other `useAi*Enabled` gates (`useAiDailyChatEnabled`, etc.). */
  enabled: boolean | null
  /** Persists the flag via `setAiFeature('chat_rag', …)`, then mirrors it
   *  into the store so every reader (Settings row + composer button) sees
   *  the same value with no session-local state.
   *
   *  Rejects with the backend's error (e.g. `AI_NOT_CONFIGURED` /
   *  `AI_PRIVACY_NOT_ACCEPTED`) instead of swallowing it — the caller needs
   *  the reason to explain the refusal. On rejection the store is left
   *  untouched: there is no optimistic flip to undo because `setFlag` only
   *  runs after `setAiFeature` resolves. */
  setEnabled: (next: boolean) => Promise<void>
}

/**
 * Read/write hook for the `ai_chat_rag_enabled` flag (Phase: RAG in Daily
 * Chat). Both the Settings → AI → Features row and the composer's RAG
 * toggle read and write through this single hook so they always agree —
 * there is no per-session state.
 */
export function useChatRagEnabled(): UseChatRagEnabledReturn {
  const hydrated = useAiSettingsStore((s) => s.hydrated)
  const enabled = useAiSettingsStore((s) => s.chatRagEnabled)
  const hydrate = useAiSettingsStore((s) => s.hydrate)

  useEffect(() => {
    if (!hydrated) void hydrate()
  }, [hydrated, hydrate])

  const setEnabled = useCallback(async (next: boolean) => {
    try {
      await setAiFeature('chat_rag', next)
    } catch (err) {
      throw new Error(extractAiErrorCode(err) ?? (err instanceof Error ? err.message : String(err)))
    }
    useAiSettingsStore.getState().setFlag('chat_rag', next)
  }, [])

  return { enabled: hydrated ? enabled : null, setEnabled }
}
