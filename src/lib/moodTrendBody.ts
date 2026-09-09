export type MoodTrendBody = 'skeleton' | 'empty' | 'chart'

/** Same empty/skeleton branching as InsightsPanel's emotion-trend section. */
export function moodTrendBody(
  isLoading: boolean,
  rows: ReadonlyArray<{ total: number }>,
): MoodTrendBody {
  if (isLoading && rows.length === 0) return 'skeleton'
  const trendTotal = rows.reduce((acc, r) => acc + r.total, 0)
  if (trendTotal === 0) return 'empty'
  return 'chart'
}
