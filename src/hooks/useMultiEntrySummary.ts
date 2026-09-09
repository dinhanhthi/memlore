import { useRef, useState } from 'react'
import { extractAiErrorCode } from '../lib/aiErrorCode'
import { summariseEntries } from '../lib/tauri'
import { estimateSummaryBytes } from '../lib/estimateSummaryBytes'

// 80 KB — payload size threshold above which a confirmation modal is shown
// before sending the request to the AI provider.
export const WARN_BYTES = 80 * 1024

export type MultiEntrySummaryState =
  | { kind: 'idle' }
  | { kind: 'pending_confirmation'; estimatedBytes: number }
  | { kind: 'loading' }
  | { kind: 'done'; markdown: string }
  | { kind: 'error'; code: string }

export interface MultiEntrySummaryEntry {
  id: string
  title: string | null
  content_text: string | null
  entry_date: number
}

export function useMultiEntrySummary(): {
  state: MultiEntrySummaryState
  request: (entries: MultiEntrySummaryEntry[]) => void
  confirm: (mode: 'truncate' | 'raw') => void
  dismiss: () => void
} {
  const [state, setState] = useState<MultiEntrySummaryState>({ kind: 'idle' })
  const storedIds = useRef<string[]>([])

  const request = (entries: MultiEntrySummaryEntry[]): void => {
    // Ignore if already loading
    if (state.kind === 'loading') return

    if (entries.length === 0) {
      setState({ kind: 'error', code: 'AI_NO_ENTRIES' })
      return
    }

    const bytes = estimateSummaryBytes(
      entries.map((e) => ({
        title: e.title,
        content_text: e.content_text,
        entry_date: e.entry_date,
      })),
    )

    const ids = entries.map((e) => e.id)

    if (bytes >= WARN_BYTES) {
      storedIds.current = ids
      setState({ kind: 'pending_confirmation', estimatedBytes: bytes })
      return
    }

    // Small payload — proceed immediately with truncate mode
    storedIds.current = ids
    setState({ kind: 'loading' })
    summariseEntries(ids, 'truncate')
      .then((markdown) => {
        setState({ kind: 'done', markdown })
      })
      .catch((err: unknown) => {
        setState({
          kind: 'error',
          code: extractAiErrorCode(err) ?? (err instanceof Error ? err.message : String(err)),
        })
      })
  }

  const confirm = (mode: 'truncate' | 'raw'): void => {
    // Only valid from pending_confirmation state
    if (state.kind !== 'pending_confirmation') return

    const ids = storedIds.current
    setState({ kind: 'loading' })
    summariseEntries(ids, mode)
      .then((markdown) => {
        setState({ kind: 'done', markdown })
      })
      .catch((err: unknown) => {
        setState({
          kind: 'error',
          code: extractAiErrorCode(err) ?? (err instanceof Error ? err.message : String(err)),
        })
      })
  }

  const dismiss = (): void => {
    storedIds.current = []
    setState({ kind: 'idle' })
  }

  return { state, request, confirm, dismiss }
}
