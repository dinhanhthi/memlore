import { useEffect, useState } from 'react'
import { suggestEmotion } from '../lib/tauri'
import type { EmotionScore } from '../types/entry'

/**
 * Fetch a single emotion suggestion for `entryId` when `active` is true.
 * Returns `null` while the request is in flight or when the backend
 * declined to suggest (entry too short / scores below threshold).
 *
 * The `active` gate is the discipline lever: callers pass
 * `pickerOpen && !userAlreadyDismissed && featureToggleOn` so the
 * suggestion only fetches when the chip would actually render. Without
 * the gate, a closed picker would still pay the (stub: cheap; ONNX:
 * 3-prototype build + cosine) cost on every entry change.
 *
 * Backend errors are swallowed into a `null` result so a transient
 * failure (entry deleted between picker open + suggest call, embedder
 * unloaded mid-call, etc.) doesn't surface as a UI error — the chip
 * just doesn't appear.
 */
export function useEmotionSuggestion(entryId: string | null, active: boolean) {
  const [suggestion, setSuggestion] = useState<EmotionScore | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    if (!active || !entryId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch reset; would need TanStack Query to fix properly
      setSuggestion(null)
      setIsLoading(false)
      return
    }
    let cancelled = false
    setIsLoading(true)
    suggestEmotion(entryId)
      .then((s) => {
        if (cancelled) return
        setSuggestion(s)
        setIsLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        // Provider down / network failure / privacy-revoked mid-session.
        // Non-fatal — the chip just doesn't render. Log at debug so
        // support exports stay clean by default.
        console.debug('[ai] suggestEmotion: backend error', { entryId, error: e })
        setSuggestion(null)
        setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [entryId, active])

  return { suggestion, isLoading }
}
