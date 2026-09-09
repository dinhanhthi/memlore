import { useCallback, useState } from 'react'
import { extractAiErrorCode } from '../lib/aiErrorCode'
import { goDeeper as goDeeperIpc } from '../lib/tauri'
import type { ReflectionLens } from '../types/ai'

/**
 * Go Deeper hook (Phase 6 v2 R8).
 *
 * Non-streaming chat call → parsed `string[]` of reflection prompts.
 * Unlike the R6/R7 streaming hooks, there's nothing to cancel mid-
 * flight (the response is small) so the state machine is just
 * `idle → loading → done|error`. `dismiss()` flips back to `idle`,
 * which the parent uses to collapse the cards.
 *
 * Errors come back as the stable `String(AiError)` shape — pass them
 * through to the caller so it can route via the same `knownCodes`
 * table the other AI features use.
 */
export type GoDeeperState =
  | { kind: 'idle' }
  | { kind: 'loading'; entryId: string }
  | { kind: 'done'; entryId: string; prompts: string[] }
  | { kind: 'error'; entryId: string; code: string }

export function useGoDeeper() {
  const [state, setState] = useState<GoDeeperState>({ kind: 'idle' })

  const generate = useCallback(async (entryId: string, lens: ReflectionLens = 'default') => {
    setState({ kind: 'loading', entryId })
    try {
      const prompts = await goDeeperIpc(entryId, lens)
      // Defensive: backend already enforces a non-empty result, but a
      // misbehaving provider could in theory return [] on a
      // best-effort fallback path. Surface that as an error rather
      // than rendering an empty card stack.
      if (!Array.isArray(prompts) || prompts.length === 0) {
        setState({ kind: 'error', entryId, code: 'AI_EMPTY_RESPONSE' })
        return
      }
      setState({ kind: 'done', entryId, prompts })
    } catch (e) {
      setState({
        kind: 'error',
        entryId,
        code: extractAiErrorCode(e) ?? 'AI_UNKNOWN_ERROR',
      })
    }
  }, [])

  const dismiss = useCallback(() => {
    setState({ kind: 'idle' })
  }, [])

  return { state, generate, dismiss }
}
