/**
 * useAiUsage — fetch and cache AI usage statistics by time period.
 *
 * Refetches whenever `period` changes. Uses a version-ref guard to discard
 * stale responses from in-flight requests that are superseded by a period
 * change (same pattern as useAiAuditLog).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { summarizeAiUsage } from '../lib/tauri'
import type { AiUsageSummary, UsagePeriod } from '../types/ai'

export interface UseAiUsageReturn {
  summary: AiUsageSummary | null
  isLoading: boolean
  error: string | null
  period: UsagePeriod
  setPeriod: (p: UsagePeriod) => void
  refresh: () => void
}

export function useAiUsage(initialPeriod: UsagePeriod = '30d'): UseAiUsageReturn {
  const [summary, setSummary] = useState<AiUsageSummary | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [period, setPeriodState] = useState<UsagePeriod>(initialPeriod)

  // Track the current period version so in-flight requests from an
  // old period don't overwrite results from the latest one.
  const versionRef = useRef(0)

  const fetchSummary = useCallback(async (p: UsagePeriod, version: number) => {
    setIsLoading(true)
    setError(null)
    try {
      const result = await summarizeAiUsage(p)
      if (version !== versionRef.current) return
      setSummary(result)
    } catch (e) {
      if (version !== versionRef.current) return
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      // Guard against stale responses: only clear loading for the latest fetch.
      if (version === versionRef.current) setIsLoading(false)
    }
  }, [])

  // Refetch whenever period changes
  useEffect(() => {
    versionRef.current += 1
    const version = versionRef.current
    fetchSummary(period, version)
  }, [period, fetchSummary])

  const setPeriod = useCallback((p: UsagePeriod) => {
    setPeriodState(p)
  }, [])

  const refresh = useCallback(() => {
    // Bump version + refetch directly; period state is unchanged.
    versionRef.current += 1
    const version = versionRef.current
    fetchSummary(period, version)
  }, [period, fetchSummary])

  return { summary, isLoading, error, period, setPeriod, refresh }
}
