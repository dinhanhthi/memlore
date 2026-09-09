/**
 * Synced `dashboard_cards` prefs: ordered `{id, enabled}` list.
 * Unknown ids are dropped; missing known ids are appended enabled.
 */

export const DASHBOARD_CARD_IDS = [
  'streak',
  'quick_stats',
  'prompt',
  'on_this_day',
  'mood_trend',
  'recent_entries',
  'ai_insights',
  'today',
  'heatmap',
  'top_tags',
  'places',
  'photos',
  'weekly_review',
  'chat',
] as const

export type DashboardCardId = (typeof DASHBOARD_CARD_IDS)[number]

export const AI_GATED_CARD_IDS = ['ai_insights', 'weekly_review', 'chat'] as const
export type AiGatedCardId = (typeof AI_GATED_CARD_IDS)[number]

export function isAiGatedCardId(id: DashboardCardId): id is AiGatedCardId {
  return (AI_GATED_CARD_IDS as readonly DashboardCardId[]).includes(id)
}

export interface DashboardCardSpan {
  cols: 1 | 2
  rows: 1 | 2
}

export const DASHBOARD_CARD_SPANS: Record<DashboardCardId, DashboardCardSpan> = {
  streak: { cols: 1, rows: 1 },
  today: { cols: 1, rows: 1 },
  quick_stats: { cols: 2, rows: 1 },
  prompt: { cols: 2, rows: 1 },
  mood_trend: { cols: 2, rows: 2 },
  heatmap: { cols: 2, rows: 2 },
  recent_entries: { cols: 2, rows: 2 },
  on_this_day: { cols: 1, rows: 2 },
  top_tags: { cols: 1, rows: 1 },
  places: { cols: 1, rows: 1 },
  photos: { cols: 2, rows: 2 },
  weekly_review: { cols: 2, rows: 2 },
  ai_insights: { cols: 2, rows: 2 },
  chat: { cols: 2, rows: 2 },
}

export function dashboardCardSpan(id: DashboardCardId, aiEnabled: boolean): DashboardCardSpan {
  if (isAiGatedCardId(id) && !aiEnabled) return { cols: 1, rows: 1 }
  return DASHBOARD_CARD_SPANS[id]
}

export function dashboardCardSpanClass(id: DashboardCardId, aiEnabled: boolean): string {
  const { cols, rows } = dashboardCardSpan(id, aiEnabled)
  const colClass = cols === 2 ? 'col-span-1 @min-[480px]:col-span-2' : 'col-span-1'
  return rows === 2 ? `${colClass} row-span-2` : colClass
}

export interface DashboardCardPref {
  id: DashboardCardId
  enabled: boolean
}

export const DEFAULT_DASHBOARD_CARDS: DashboardCardPref[] = DASHBOARD_CARD_IDS.map((id) => ({
  id,
  enabled: true,
}))

function isDashboardCardId(id: string): id is DashboardCardId {
  return (DASHBOARD_CARD_IDS as readonly string[]).includes(id)
}

function isPrefShape(value: unknown): value is { id: string; enabled: boolean } {
  if (typeof value !== 'object' || value === null) return false
  if (!('id' in value) || !('enabled' in value)) return false
  return typeof value.id === 'string' && typeof value.enabled === 'boolean'
}

function copyDefaults(): DashboardCardPref[] {
  return DEFAULT_DASHBOARD_CARDS.map((pref) => ({ ...pref }))
}

export function parseDashboardCards(raw: string | null): DashboardCardPref[] {
  if (raw == null) return copyDefaults()

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return copyDefaults()
  }
  if (!Array.isArray(parsed)) return copyDefaults()

  const seen = new Set<DashboardCardId>()
  const result: DashboardCardPref[] = []
  for (const item of parsed) {
    if (!isPrefShape(item)) return copyDefaults()
    if (!isDashboardCardId(item.id) || seen.has(item.id)) continue
    seen.add(item.id)
    result.push({ id: item.id, enabled: item.enabled })
  }

  for (const id of DASHBOARD_CARD_IDS) {
    if (!seen.has(id)) result.push({ id, enabled: true })
  }
  return result
}

export function serializeDashboardCards(prefs: DashboardCardPref[]): string {
  return JSON.stringify(prefs)
}
