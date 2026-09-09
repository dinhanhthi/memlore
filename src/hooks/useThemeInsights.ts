import { useCallback, useMemo, useState } from 'react'
import { extractAiErrorCodeOrDetail } from '../lib/aiErrorCode'
import { generateThemeInsights, listEntriesForDateRange } from '../lib/tauri'
import type { EndpointClass, ThemeInsightsResult } from '../types/ai'

export type ThemeInsightsPhase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; result: ThemeInsightsResult }
  | { kind: 'error'; code: string }
  | {
      kind: 'needs_bulk_consent'
      endpointClass: EndpointClass
      entryCount: number
      start: number
      end: number
      regenerate: boolean
    }

export interface UseThemeInsightsOptions {
  start: number
  end: number
  needsBulkConsent: (cls: EndpointClass) => boolean
  generationEndpointClass: EndpointClass | null
}

export function useThemeInsights({
  start,
  end,
  needsBulkConsent,
  generationEndpointClass,
}: UseThemeInsightsOptions) {
  const [phase, setPhase] = useState<ThemeInsightsPhase>({ kind: 'idle' })

  const bounds = useMemo(() => ({ start, end }), [end, start])

  const runGenerate = useCallback(
    async (regenerate: boolean) => {
      setPhase({ kind: 'loading' })
      try {
        const result = await generateThemeInsights(bounds.start, bounds.end, regenerate)
        setPhase({ kind: 'ready', result })
      } catch (err) {
        setPhase({
          kind: 'error',
          code:
            extractAiErrorCodeOrDetail(err) ?? (err instanceof Error ? err.message : String(err)),
        })
      }
    },
    [bounds.end, bounds.start],
  )

  const generate = useCallback(
    async (regenerate = false) => {
      const cls = generationEndpointClass
      if (!cls) {
        setPhase({ kind: 'error', code: 'AI_NOT_CONFIGURED' })
        return
      }

      if (cls !== 'local' && needsBulkConsent(cls)) {
        try {
          const entries = await listEntriesForDateRange(null, bounds.start, bounds.end)
          const withContent = entries.filter((e) => (e.content_text ?? '').trim().length > 0)
          if (withContent.length === 0) {
            setPhase({ kind: 'error', code: 'AI_NO_ENTRIES_WITH_CONTENT' })
            return
          }
          setPhase({
            kind: 'needs_bulk_consent',
            endpointClass: cls,
            entryCount: withContent.length,
            start: bounds.start,
            end: bounds.end,
            regenerate,
          })
          return
        } catch (err) {
          setPhase({
            kind: 'error',
            code:
              extractAiErrorCodeOrDetail(err) ?? (err instanceof Error ? err.message : String(err)),
          })
          return
        }
      }

      await runGenerate(regenerate)
    },
    [bounds.end, bounds.start, generationEndpointClass, needsBulkConsent, runGenerate],
  )

  const confirmBulkConsent = useCallback(async () => {
    if (phase.kind !== 'needs_bulk_consent') return
    await runGenerate(phase.regenerate)
  }, [phase, runGenerate])

  const dismiss = useCallback(() => {
    setPhase({ kind: 'idle' })
  }, [])

  return { phase, generate, confirmBulkConsent, dismiss }
}
