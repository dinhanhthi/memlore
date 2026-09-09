import { describe, expect, it } from 'vitest'
import type { AiAuditLogRow, AiUsageSummary } from '../../types/ai'
import { buildJsonFile } from './json'

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
  per_provider: [],
  breakdown: [],
  daily: [],
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

function parse(file: ReturnType<typeof buildJsonFile>) {
  return JSON.parse(new TextDecoder().decode(file.bytes))
}

describe('buildJsonFile', () => {
  it('includes generatedAt and the selected sections list', () => {
    const file = buildJsonFile(
      { generatedAt: '2026-05-17T12:00:00Z', charts: null, usage: SAMPLE_USAGE, audit: null },
      { charts: false, usage: true, audit: false },
    )
    const json = parse(file)
    expect(json.generatedAt).toBe('2026-05-17T12:00:00Z')
    expect(json.sections).toEqual(['usage'])
  })

  it('keeps non-selected sections as null', () => {
    const file = buildJsonFile(
      {
        generatedAt: '2026-05-17T12:00:00Z',
        charts: null,
        usage: SAMPLE_USAGE,
        audit: SAMPLE_AUDIT,
      },
      { charts: false, usage: false, audit: true },
    )
    const json = parse(file)
    expect(json.usage).toBeNull()
    expect(json.audit).toEqual(SAMPLE_AUDIT)
  })

  it('renders usage data verbatim under the "usage" key', () => {
    const file = buildJsonFile(
      { generatedAt: '2026-05-17T12:00:00Z', charts: null, usage: SAMPLE_USAGE, audit: null },
      { charts: false, usage: true, audit: false },
    )
    const json = parse(file)
    expect(json.usage).toEqual(SAMPLE_USAGE)
  })

  it('embeds the charts bundle verbatim when charts is selected', () => {
    const charts = {
      rangeDays: 365,
      streakYear: 2026,
      entries_over_time: [{ period_start: '2026-05-17', count: 3 }],
      writing_volume: [],
      mood_histogram: [{ emotion: 'good', count: 5 }],
      mood_trend: [],
      tag_frequency: [],
      streak_calendar: [],
      location_density: [],
    }
    const file = buildJsonFile(
      { generatedAt: '2026-05-17T12:00:00Z', charts, usage: null, audit: null },
      { charts: true, usage: false, audit: false },
    )
    const json = parse(file)
    expect(json.charts).toEqual(charts)
    expect(json.sections).toEqual(['charts'])
  })

  it('null-charts even when section is checked but data is missing', () => {
    const file = buildJsonFile(
      { generatedAt: '2026-05-17T12:00:00Z', charts: null, usage: null, audit: null },
      { charts: true, usage: false, audit: false },
    )
    const json = parse(file)
    expect(json.charts).toBeNull()
  })
})
