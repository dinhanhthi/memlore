import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { extractAiErrorCodeOrDetail } from '../lib/aiErrorCode'
import { generatePeriodReview, getPeriodReview, listEntriesForDateRange } from '../lib/tauri'
import { periodRange } from '../lib/periodReview'
import type { EndpointClass, PeriodReviewKind, PeriodReviewResult } from '../types/ai'

export type PeriodReviewPhase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; result: PeriodReviewResult }
  | { kind: 'error'; code: string }
  | {
      kind: 'needs_bulk_consent'
      endpointClass: EndpointClass
      entryCount: number
      start: number
      end: number
      regenerate: boolean
    }

export interface UsePeriodReviewOptions {
  kind: PeriodReviewKind
  anchorSec: number
  locale?: string
  needsBulkConsent: (cls: EndpointClass) => boolean
  generationEndpointClass: EndpointClass | null
}

export function usePeriodReview({
  kind,
  anchorSec,
  locale,
  needsBulkConsent,
  generationEndpointClass,
}: UsePeriodReviewOptions) {
  const bounds = useMemo(() => periodRange(kind, anchorSec, locale), [kind, anchorSec, locale])
  const [phase, setPhase] = useState<PeriodReviewPhase>({ kind: 'idle' })
  const requestIdRef = useRef(0)

  useEffect(() => {
    const requestId = ++requestIdRef.current
    setPhase({ kind: 'idle' })
    void getPeriodReview(bounds.start, bounds.end, kind)
      .then((result) => {
        if (requestId !== requestIdRef.current) return
        setPhase(result ? { kind: 'ready', result } : { kind: 'idle' })
      })
      .catch(() => {
        if (requestId !== requestIdRef.current) return
        setPhase({ kind: 'idle' })
      })
  }, [bounds.end, bounds.start, kind])

  const runGenerate = useCallback(
    async (regenerate: boolean) => {
      const requestId = ++requestIdRef.current
      setPhase({ kind: 'loading' })
      try {
        const result = await generatePeriodReview(bounds.start, bounds.end, kind, regenerate)
        if (requestId !== requestIdRef.current) return
        setPhase({ kind: 'ready', result })
      } catch (err) {
        if (requestId !== requestIdRef.current) return
        setPhase({
          kind: 'error',
          code:
            extractAiErrorCodeOrDetail(err) ?? (err instanceof Error ? err.message : String(err)),
        })
      }
    },
    [bounds.end, bounds.start, kind],
  )

  const generate = useCallback(
    async (regenerate = false) => {
      const requestId = ++requestIdRef.current
      const cls = generationEndpointClass
      if (!cls) {
        setPhase({ kind: 'error', code: 'AI_NOT_CONFIGURED' })
        return
      }

      if (cls !== 'local' && needsBulkConsent(cls)) {
        try {
          const entries = await listEntriesForDateRange(null, bounds.start, bounds.end)
          if (requestId !== requestIdRef.current) return
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
          if (requestId !== requestIdRef.current) return
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
    const requestId = ++requestIdRef.current
    void getPeriodReview(bounds.start, bounds.end, kind)
      .then((result) => {
        if (requestId !== requestIdRef.current) return
        setPhase(result ? { kind: 'ready', result } : { kind: 'idle' })
      })
      .catch(() => {
        if (requestId !== requestIdRef.current) return
        setPhase({ kind: 'idle' })
      })
  }, [bounds.end, bounds.start, kind])

  return {
    bounds,
    phase,
    generate,
    confirmBulkConsent,
    dismiss,
  }
}
