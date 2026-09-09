import type { AiAuditLogRow, AiUsageSummary } from '../../types/ai'
import { buildChartsCsvs } from './charts'
import type { BuiltFile, ExportBundle, ExportSections } from './types'

// ─── CSV primitives ───────────────────────────────────────────────────────────

/** Escape a single CSV cell per RFC 4180:
 *  - Wrap in quotes when the value contains a comma, quote, or newline.
 *  - Double any embedded quotes.
 *  - Treat `null`/`undefined` as the empty string.
 */
function csvCell(v: string | number | null | undefined): string {
  if (v == null) return ''
  const s = String(v)
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

/** Build a CSV string from a header row + body rows. */
export function toCsv(
  header: string[],
  rows: Array<Array<string | number | null | undefined>>,
): string {
  const out: string[] = []
  out.push(header.map(csvCell).join(','))
  for (const r of rows) {
    out.push(r.map(csvCell).join(','))
  }
  // Trailing newline so editors that auto-strip it on save don't see
  // a diff when re-saving the file.
  return out.join('\n') + '\n'
}

// ─── Per-section builders ─────────────────────────────────────────────────────

const TEXT_ENCODER = new TextEncoder()

function utf8(name: string, text: string): BuiltFile {
  return { name, mime: 'text/csv;charset=utf-8', bytes: TEXT_ENCODER.encode(text) }
}

function buildUsageCsvs(summary: AiUsageSummary): BuiltFile[] {
  const headline = toCsv(
    ['period', 'since_ms', 'calls', 'tokens_in', 'tokens_out', 'payload_bytes', 'null_token_calls'],
    [
      [
        summary.period,
        summary.since_ms,
        summary.headline.calls,
        summary.headline.tokens_in,
        summary.headline.tokens_out,
        summary.headline.payload_bytes,
        summary.headline.null_token_calls,
      ],
    ],
  )

  const perProvider = toCsv(
    ['provider_id', 'calls', 'tokens_in', 'tokens_out', 'payload_bytes', 'null_token_calls'],
    summary.per_provider.map((r) => [
      r.provider_id,
      r.calls,
      r.tokens_in,
      r.tokens_out,
      r.payload_bytes,
      r.null_token_calls,
    ]),
  )

  const breakdown = toCsv(
    [
      'provider_id',
      'model_id',
      'feature',
      'calls',
      'tokens_in',
      'tokens_out',
      'payload_bytes',
      'avg_latency_ms',
      'error_rate',
      'null_token_calls',
    ],
    summary.breakdown.map((r) => [
      r.provider_id,
      r.model_id,
      r.feature,
      r.calls,
      r.tokens_in,
      r.tokens_out,
      r.payload_bytes,
      r.avg_latency_ms,
      r.error_rate,
      r.null_token_calls,
    ]),
  )

  const daily = toCsv(
    ['date', 'calls', 'tokens_in', 'tokens_out'],
    summary.daily.map((d) => [d.date, d.calls, d.tokens_in, d.tokens_out]),
  )

  return [
    utf8('ai-usage-headline.csv', headline),
    utf8('ai-usage-per-provider.csv', perProvider),
    utf8('ai-usage-breakdown.csv', breakdown),
    utf8('ai-usage-daily.csv', daily),
  ]
}

function buildAuditCsv(rows: AiAuditLogRow[]): BuiltFile {
  const text = toCsv(
    [
      'device_id',
      'device_name',
      'local_seq',
      'created_at',
      'feature',
      'operation',
      'provider_id',
      'model_id',
      'endpoint_host',
      'endpoint_class',
      'payload_bytes',
      'latency_ms',
      'status',
      'error_code',
      'tokens_in',
      'tokens_out',
    ],
    rows.map((r) => [
      r.device_id,
      r.device_name,
      r.local_seq,
      r.created_at,
      r.feature,
      r.operation,
      r.provider_id,
      r.model_id,
      r.endpoint_host,
      r.endpoint_class,
      r.payload_bytes,
      r.latency_ms,
      r.status,
      r.error_code,
      r.tokens_in,
      r.tokens_out,
    ]),
  )
  return utf8('ai-audit-log.csv', text)
}

// ─── Top-level builder ────────────────────────────────────────────────────────

/** Produce one or more CSV files for the chosen sections.
 *
 *  Each section contributes its own file(s) because mixing different
 *  row shapes into one CSV would lose column semantics. The caller is
 *  responsible for zipping when `files.length > 1`. */
export function buildCsvFiles(bundle: ExportBundle, sections: ExportSections): BuiltFile[] {
  const out: BuiltFile[] = []
  if (sections.charts && bundle.charts) {
    out.push(...buildChartsCsvs(bundle.charts))
  }
  if (sections.usage && bundle.usage) {
    out.push(...buildUsageCsvs(bundle.usage))
  }
  if (sections.audit && bundle.audit) {
    out.push(buildAuditCsv(bundle.audit))
  }
  return out
}
