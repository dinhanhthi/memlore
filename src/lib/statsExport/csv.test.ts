import { describe, expect, it } from 'vitest'
import type { AiAuditLogRow, AiUsageSummary } from '../../types/ai'
import { buildCsvFiles, toCsv } from './csv'

describe('toCsv', () => {
  it('emits header + rows separated by newlines', () => {
    const out = toCsv(
      ['a', 'b'],
      [
        [1, 2],
        [3, 4],
      ],
    )
    expect(out).toBe('a,b\n1,2\n3,4\n')
  })

  it('escapes quotes by doubling them and wraps cells with commas', () => {
    const out = toCsv(['x'], [['hello, "world"']])
    expect(out).toBe('x\n"hello, ""world"""\n')
  })

  it('treats null and undefined as empty cells', () => {
    const out = toCsv(['a', 'b', 'c'], [[null, undefined, 'x']])
    expect(out).toBe('a,b,c\n,,x\n')
  })

  it('quotes cells containing newlines', () => {
    const out = toCsv(['x'], [['line1\nline2']])
    expect(out).toBe('x\n"line1\nline2"\n')
  })
})

// ─── Section builders ─────────────────────────────────────────────────────────

const SAMPLE_USAGE: AiUsageSummary = {
  period: '30d',
  since_ms: 1_700_000_000_000,
  headline: {
    calls: 5,
    tokens_in: 100,
    tokens_out: 200,
    payload_bytes: 1024,
    null_token_calls: 1,
  },
  per_provider: [
    {
      provider_id: 'openai',
      calls: 3,
      tokens_in: 60,
      tokens_out: 120,
      payload_bytes: 512,
      null_token_calls: 0,
    },
  ],
  breakdown: [
    {
      provider_id: 'openai',
      model_id: 'gpt-4o',
      feature: 'daily_chat',
      calls: 3,
      tokens_in: 60,
      tokens_out: 120,
      payload_bytes: 512,
      avg_latency_ms: 250,
      error_rate: 0,
      null_token_calls: 0,
    },
  ],
  daily: [{ date: '2026-05-17', calls: 1, tokens_in: 20, tokens_out: 40 }],
}

const SAMPLE_AUDIT: AiAuditLogRow[] = [
  {
    device_id: 'dev-1',
    local_seq: 1,
    created_at: 1_700_000_000_000,
    feature: 'daily_chat',
    operation: 'chat',
    provider_id: 'openai',
    model_id: 'gpt-4o',
    endpoint_host: 'api.openai.com',
    endpoint_class: 'remote',
    payload_bytes: 256,
    latency_ms: 180,
    status: 'ok',
    error_code: null,
    tokens_in: 30,
    tokens_out: 70,
    device_name: 'MacBook Pro',
  },
]

const SAMPLE_CHARTS = {
  rangeDays: 365,
  streakYear: 2026,
  entries_over_time: [{ period_start: '2026-05-17', count: 3 }],
  writing_volume: [{ period_start: '2026-05-17', total_words: 420, entry_count: 3 }],
  mood_histogram: [{ emotion: 'good', count: 5 }],
  mood_trend: [{ day: '2026-05-17', sample_count: 2 }],
  tag_frequency: [{ tag_id: 't1', tag_name: 'family', count: 7 }],
  streak_calendar: [{ date: '2026-05-17', entry_count: 1 }],
  location_density: [{ lat: 21.03, lng: 105.85, count: 4 }],
}

describe('buildCsvFiles', () => {
  it('produces 4 files when usage is selected and audit is not', () => {
    const files = buildCsvFiles(
      { generatedAt: '2026-05-17T12:00:00Z', charts: null, usage: SAMPLE_USAGE, audit: null },
      { charts: false, usage: true, audit: false },
    )
    const names = files.map((f) => f.name).sort()
    expect(names).toEqual([
      'ai-usage-breakdown.csv',
      'ai-usage-daily.csv',
      'ai-usage-headline.csv',
      'ai-usage-per-provider.csv',
    ])
  })

  it('produces exactly one audit file when only audit is selected', () => {
    const files = buildCsvFiles(
      { generatedAt: '2026-05-17T12:00:00Z', charts: null, usage: null, audit: SAMPLE_AUDIT },
      { charts: false, usage: false, audit: true },
    )
    expect(files).toHaveLength(1)
    expect(files[0].name).toBe('ai-audit-log.csv')
  })

  it('includes the row values in the audit CSV body', () => {
    const files = buildCsvFiles(
      { generatedAt: '2026-05-17T12:00:00Z', charts: null, usage: null, audit: SAMPLE_AUDIT },
      { charts: false, usage: false, audit: true },
    )
    const text = new TextDecoder().decode(files[0].bytes)
    expect(text).toContain('daily_chat')
    expect(text).toContain('gpt-4o')
    expect(text).toContain('180')
  })

  it('skips sections that are not selected even when data is present', () => {
    const files = buildCsvFiles(
      {
        generatedAt: '2026-05-17T12:00:00Z',
        charts: null,
        usage: SAMPLE_USAGE,
        audit: SAMPLE_AUDIT,
      },
      { charts: false, usage: false, audit: false },
    )
    expect(files).toEqual([])
  })

  it('emits one CSV per chart dataset when charts is selected', () => {
    const files = buildCsvFiles(
      { generatedAt: '2026-05-17T12:00:00Z', charts: SAMPLE_CHARTS, usage: null, audit: null },
      { charts: true, usage: false, audit: false },
    )
    const names = files.map((f) => f.name).sort()
    expect(names).toEqual([
      'charts/entries-over-time.csv',
      'charts/location-density.csv',
      'charts/mood-histogram.csv',
      'charts/mood-trend.csv',
      'charts/streak-calendar.csv',
      'charts/tag-frequency.csv',
      'charts/writing-volume.csv',
    ])
  })

  it('combines charts + usage + audit when all sections are selected', () => {
    const files = buildCsvFiles(
      {
        generatedAt: '2026-05-17T12:00:00Z',
        charts: SAMPLE_CHARTS,
        usage: SAMPLE_USAGE,
        audit: SAMPLE_AUDIT,
      },
      { charts: true, usage: true, audit: true },
    )
    // 7 charts + 4 usage + 1 audit = 12 files
    expect(files).toHaveLength(12)
  })
})
