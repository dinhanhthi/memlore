import { describe, expect, it } from 'vitest'
import {
  AI_GATED_CARD_IDS,
  DASHBOARD_CARD_IDS,
  DASHBOARD_CARD_SPANS,
  DEFAULT_DASHBOARD_CARDS,
  dashboardCardSpan,
  dashboardCardSpanClass,
  isAiGatedCardId,
  parseDashboardCards,
  serializeDashboardCards,
  type DashboardCardId,
  type DashboardCardPref,
  type DashboardCardSpan,
} from './dashboardCards'

const ALL_ENABLED: DashboardCardPref[] = DASHBOARD_CARD_IDS.map((id) => ({
  id,
  enabled: true,
}))

function appendedEnabled(present: readonly DashboardCardId[]): DashboardCardPref[] {
  return DASHBOARD_CARD_IDS.filter((id) => !present.includes(id)).map((id) => ({
    id,
    enabled: true,
  }))
}

describe('DASHBOARD_CARD_IDS', () => {
  it('lists the fourteen cards in default order', () => {
    expect(DASHBOARD_CARD_IDS).toEqual([
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
    ])
  })
})

describe('DEFAULT_DASHBOARD_CARDS', () => {
  it('enables every known id in DASHBOARD_CARD_IDS order', () => {
    expect(DEFAULT_DASHBOARD_CARDS).toEqual(ALL_ENABLED)
  })
})

describe('AI_GATED_CARD_IDS', () => {
  it('lists ai_insights, weekly_review, and chat', () => {
    expect(AI_GATED_CARD_IDS).toEqual(['ai_insights', 'weekly_review', 'chat'])
  })

  it('isAiGatedCardId is true only for those three ids', () => {
    expect(isAiGatedCardId('ai_insights')).toBe(true)
    expect(isAiGatedCardId('weekly_review')).toBe(true)
    expect(isAiGatedCardId('chat')).toBe(true)
    expect(isAiGatedCardId('streak')).toBe(false)
    expect(isAiGatedCardId('mood_trend')).toBe(false)
  })
})

describe('parseDashboardCards', () => {
  it('returns the default prefs when raw is null', () => {
    expect(parseDashboardCards(null)).toEqual(DEFAULT_DASHBOARD_CARDS)
  })

  it('returns the default prefs when raw is not valid JSON', () => {
    expect(parseDashboardCards('not-json')).toEqual(DEFAULT_DASHBOARD_CARDS)
    expect(parseDashboardCards('{')).toEqual(DEFAULT_DASHBOARD_CARDS)
  })

  it('returns the default prefs when JSON is a non-array', () => {
    expect(parseDashboardCards('{}')).toEqual(DEFAULT_DASHBOARD_CARDS)
    expect(parseDashboardCards('"streak"')).toEqual(DEFAULT_DASHBOARD_CARDS)
    expect(parseDashboardCards('1')).toEqual(DEFAULT_DASHBOARD_CARDS)
  })

  it('returns the default prefs when an item lacks a string id and boolean enabled', () => {
    expect(parseDashboardCards('[{"id":"streak"}]')).toEqual(DEFAULT_DASHBOARD_CARDS)
    expect(parseDashboardCards('[{"enabled":true}]')).toEqual(DEFAULT_DASHBOARD_CARDS)
    expect(parseDashboardCards('[{"id":1,"enabled":true}]')).toEqual(DEFAULT_DASHBOARD_CARDS)
    expect(parseDashboardCards('[{"id":"streak","enabled":"yes"}]')).toEqual(
      DEFAULT_DASHBOARD_CARDS,
    )
  })

  it('returns default order all enabled when the stored array is empty', () => {
    expect(parseDashboardCards('[]')).toEqual(DEFAULT_DASHBOARD_CARDS)
  })

  it('drops unknown ids', () => {
    expect(
      parseDashboardCards(
        JSON.stringify([
          { id: 'streak', enabled: true },
          { id: 'not_a_card', enabled: true },
          { id: 'prompt', enabled: false },
        ]),
      ),
    ).toEqual([
      { id: 'streak', enabled: true },
      { id: 'prompt', enabled: false },
      ...appendedEnabled(['streak', 'prompt']),
    ])
  })

  it('appends missing known ids at the end, enabled', () => {
    expect(parseDashboardCards(JSON.stringify([{ id: 'prompt', enabled: false }]))).toEqual([
      { id: 'prompt', enabled: false },
      ...appendedEnabled(['prompt']),
    ])
  })

  it('appends all 13 other ids enabled when only streak is stored', () => {
    expect(parseDashboardCards('[{"id":"streak","enabled":true}]')).toEqual([
      { id: 'streak', enabled: true },
      ...appendedEnabled(['streak']),
    ])
    expect(appendedEnabled(['streak'])).toHaveLength(13)
    expect(appendedEnabled(['streak']).every((pref) => pref.enabled)).toBe(true)
  })

  it('dedupes duplicate ids, keeping the first occurrence', () => {
    expect(
      parseDashboardCards(
        JSON.stringify([
          { id: 'prompt', enabled: false },
          { id: 'prompt', enabled: true },
          { id: 'streak', enabled: true },
        ]),
      ),
    ).toEqual([
      { id: 'prompt', enabled: false },
      { id: 'streak', enabled: true },
      ...appendedEnabled(['prompt', 'streak']),
    ])
  })

  it('preserves the stored order of known ids', () => {
    expect(
      parseDashboardCards(
        JSON.stringify([
          { id: 'ai_insights', enabled: true },
          { id: 'streak', enabled: true },
        ]),
      ),
    ).toEqual([
      { id: 'ai_insights', enabled: true },
      { id: 'streak', enabled: true },
      ...appendedEnabled(['ai_insights', 'streak']),
    ])
  })

  it('preserves the disabled flag on known ids', () => {
    const stored: DashboardCardPref[] = [
      { id: 'streak', enabled: false },
      { id: 'quick_stats', enabled: false },
      { id: 'prompt', enabled: true },
      { id: 'on_this_day', enabled: true },
      { id: 'mood_trend', enabled: false },
      { id: 'recent_entries', enabled: true },
      { id: 'ai_insights', enabled: false },
    ]
    expect(parseDashboardCards(JSON.stringify(stored))).toEqual([
      ...stored,
      ...appendedEnabled(stored.map((pref) => pref.id)),
    ])
  })
})

describe('serializeDashboardCards', () => {
  it('round-trips through parseDashboardCards', () => {
    const originalSeven: DashboardCardPref[] = [
      { id: 'mood_trend', enabled: false },
      { id: 'streak', enabled: true },
      { id: 'quick_stats', enabled: false },
      { id: 'prompt', enabled: true },
      { id: 'on_this_day', enabled: true },
      { id: 'recent_entries', enabled: false },
      { id: 'ai_insights', enabled: true },
    ]
    const prefs: DashboardCardPref[] = [
      ...originalSeven,
      ...appendedEnabled(originalSeven.map((pref) => pref.id)),
    ]
    expect(parseDashboardCards(serializeDashboardCards(prefs))).toEqual(prefs)
    expect(parseDashboardCards(serializeDashboardCards(DEFAULT_DASHBOARD_CARDS))).toEqual(
      DEFAULT_DASHBOARD_CARDS,
    )
  })
})

describe('DASHBOARD_CARD_SPANS', () => {
  const EXPECTED_SPANS: Record<DashboardCardId, DashboardCardSpan> = {
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

  it('has a span for every known id', () => {
    for (const id of DASHBOARD_CARD_IDS) {
      expect(DASHBOARD_CARD_SPANS[id]).toEqual(EXPECTED_SPANS[id])
    }
    expect(Object.keys(DASHBOARD_CARD_SPANS)).toHaveLength(DASHBOARD_CARD_IDS.length)
  })
})

describe('dashboardCardSpan', () => {
  it('collapses ai_insights to 1x1 when AI is disabled', () => {
    expect(dashboardCardSpan('ai_insights', false)).toEqual({ cols: 1, rows: 1 })
  })

  it('returns the table entry for streak even when AI is disabled', () => {
    expect(dashboardCardSpan('streak', false)).toEqual(DASHBOARD_CARD_SPANS.streak)
    expect(dashboardCardSpan('streak', false)).toEqual({ cols: 1, rows: 1 })
  })

  it('sums to 38 cells across all cards when AI is enabled', () => {
    const area = DASHBOARD_CARD_IDS.reduce((sum, id) => {
      const { cols, rows } = dashboardCardSpan(id, true)
      return sum + cols * rows
    }, 0)
    expect(area).toBe(38)
  })
})

describe('dashboardCardSpanClass', () => {
  it('uses container-query col-span and row-span-2 for mood_trend', () => {
    expect(dashboardCardSpanClass('mood_trend', true)).toBe(
      'col-span-1 @min-[480px]:col-span-2 row-span-2',
    )
  })

  it('uses a single-column class for streak', () => {
    expect(dashboardCardSpanClass('streak', true)).toBe('col-span-1')
  })

  it('collapses chat to a single-column class when AI is disabled', () => {
    expect(dashboardCardSpanClass('chat', false)).toBe('col-span-1')
  })
})
