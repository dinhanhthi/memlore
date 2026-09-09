import { useCallback, useState } from 'react'
import { extractAiErrorCode } from '../lib/aiErrorCode'
import { suggestTags as suggestTagsIpc } from '../lib/tauri'

export type SuggestTagsState =
  | { kind: 'idle' }
  | { kind: 'loading'; entryId: string }
  | { kind: 'done'; entryId: string; suggestions: string[] }
  | { kind: 'error'; entryId: string; code: string }

/**
 * AI tag suggestions for a single entry. Non-streaming — backend returns
 * a short list of tag names the user confirms one-tap at a time.
 */
export function useSuggestTags() {
  const [state, setState] = useState<SuggestTagsState>({ kind: 'idle' })

  const suggest = useCallback(async (entryId: string) => {
    setState({ kind: 'loading', entryId })
    try {
      const suggestions = await suggestTagsIpc(entryId)
      if (!Array.isArray(suggestions) || suggestions.length === 0) {
        setState({ kind: 'error', entryId, code: 'AI_EMPTY_RESPONSE' })
        return
      }
      setState({ kind: 'done', entryId, suggestions })
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

  const removeSuggestion = useCallback((name: string) => {
    setState((prev) => {
      if (prev.kind !== 'done') return prev
      const next = prev.suggestions.filter((s) => s !== name)
      if (next.length === 0) return { kind: 'idle' }
      return { ...prev, suggestions: next }
    })
  }, [])

  return { state, suggest, dismiss, removeSuggestion }
}
