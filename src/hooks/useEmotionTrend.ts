import { useMemo } from 'react'
import { statsEmotionTrend } from '../lib/tauri'
import type { EmotionTrendBucket } from '../lib/tauri'
import { useStats } from './useStats'
import type { Period } from '../components/stats/PeriodSelector'

const PERIOD_CONFIG: Record<Period, { rangeDays: number; bucket: 'day' | 'week' }> = {
  '7d': { rangeDays: 7, bucket: 'day' },
  '30d': { rangeDays: 30, bucket: 'day' },
  '90d': { rangeDays: 90, bucket: 'week' },
  '365d': { rangeDays: 365, bucket: 'week' },
  all: { rangeDays: 3650, bucket: 'week' },
}

export interface EmotionTrendChartRow {
  periodStart: string
  bad: number
  neutral: number
  good: number
  total: number
  badRatio: number
  neutralRatio: number
  goodRatio: number
}

function toChartRows(buckets: EmotionTrendBucket[]): EmotionTrendChartRow[] {
  return buckets.map((b) => {
    const total = Number(b.total_count)
    const bad = Number(b.bad_count)
    const neutral = Number(b.neutral_count)
    const good = Number(b.good_count)
    const ratio = (n: number) => (total > 0 ? n / total : 0)
    return {
      periodStart: b.period_start,
      bad,
      neutral,
      good,
      total,
      badRatio: ratio(bad),
      neutralRatio: ratio(neutral),
      goodRatio: ratio(good),
    }
  })
}

export function useEmotionTrend(period: Period) {
  const { rangeDays, bucket } = PERIOD_CONFIG[period]
  const cacheKey = `emotion_trend:${bucket}:${rangeDays}`

  const { data, isLoading, error } = useStats<EmotionTrendBucket[]>(
    () => statsEmotionTrend(bucket, rangeDays),
    cacheKey,
  )

  const rows = useMemo(() => toChartRows(data ?? []), [data])

  return { rows, isLoading, error, rangeDays, bucket }
}
