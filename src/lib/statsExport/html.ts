import type { AiAuditLogRow, AiUsageSummary } from '../../types/ai'
import { renderChartsHtmlSection } from './charts'
import type { ChartSnapshot } from './png'
import type { BuiltFile, ExportBundle, ExportSections } from './types'

const TEXT_ENCODER = new TextEncoder()

/** Minimal HTML entity escape. The export is offline-viewed, so we
 *  only need the five base entities to keep arbitrary user-supplied
 *  values (feature names, model IDs) from breaking the document. */
function esc(v: unknown): string {
  if (v == null) return ''
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderTable(headers: string[], rows: Array<Array<string | number | null>>): string {
  const thead = `<thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>`
  const tbody = `<tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
    .join('')}</tbody>`
  return `<table>${thead}${tbody}</table>`
}

function renderUsageSection(summary: AiUsageSummary): string {
  const headline = renderTable(
    ['Metric', 'Value'],
    [
      ['Period', summary.period],
      ['Since (unix ms)', summary.since_ms],
      ['Calls', summary.headline.calls],
      ['Tokens in', summary.headline.tokens_in],
      ['Tokens out', summary.headline.tokens_out],
      ['Payload bytes', summary.headline.payload_bytes],
      ['Calls with null tokens', summary.headline.null_token_calls],
    ],
  )

  const perProvider = renderTable(
    ['Provider', 'Calls', 'Tokens in', 'Tokens out', 'Payload bytes', 'Null-token calls'],
    summary.per_provider.map((r) => [
      r.provider_id,
      r.calls,
      r.tokens_in,
      r.tokens_out,
      r.payload_bytes,
      r.null_token_calls,
    ]),
  )

  const breakdown = renderTable(
    [
      'Provider',
      'Model',
      'Feature',
      'Calls',
      'Tokens in',
      'Tokens out',
      'Payload bytes',
      'Avg latency (ms)',
      'Error rate',
      'Null-token calls',
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
      r.error_rate.toFixed(3),
      r.null_token_calls,
    ]),
  )

  const daily = renderTable(
    ['Date', 'Calls', 'Tokens in', 'Tokens out'],
    summary.daily.map((d) => [d.date, d.calls, d.tokens_in, d.tokens_out]),
  )

  return `
<section>
  <h2>AI usage</h2>
  <h3>Headline</h3>${headline}
  <h3>Per provider</h3>${perProvider}
  <h3>Breakdown</h3>${breakdown}
  <h3>Daily</h3>${daily}
</section>`
}

function renderAuditSection(rows: AiAuditLogRow[]): string {
  const table = renderTable(
    [
      'Device ID',
      'Device name',
      'Seq',
      'Created at',
      'Feature',
      'Operation',
      'Provider',
      'Model',
      'Endpoint host',
      'Endpoint class',
      'Payload bytes',
      'Latency (ms)',
      'Status',
      'Error code',
      'Tokens in',
      'Tokens out',
    ],
    rows.map((r) => [
      r.device_id,
      r.device_name,
      r.local_seq,
      new Date(r.created_at).toISOString(),
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

  return `
<section>
  <h2>AI audit log</h2>
  <p class="meta">${rows.length} row${rows.length === 1 ? '' : 's'}</p>
  ${table}
</section>`
}

/** Convert a Uint8Array of PNG bytes into a `data:` URL fragment
 *  suitable for embedding in an `<img src>`. Same chunked-conversion
 *  pattern as `pdf.ts` to avoid the call-stack blow-up on large arrays. */
function pngToDataUrl(bytes: Uint8Array): string {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return `data:image/png;base64,${btoa(s)}`
}

function renderChartImagesSection(snapshots: ChartSnapshot[]): string {
  if (snapshots.length === 0) return ''
  const imgs = snapshots
    .map((s) => {
      const slug = s.filename.replace(/^charts\//, '').replace(/\.png$/, '')
      const src = pngToDataUrl(s.bytes)
      return `
  <figure class="chart-fig">
    <figcaption>${esc(slug)}</figcaption>
    <img src="${src}" alt="${esc(slug)}" />
  </figure>`
    })
    .join('\n')
  return `
<section>
  <h2>Chart visuals</h2>
  ${imgs}
</section>`
}

/** Build a single self-contained HTML file with one `<section>` per
 *  selected export section. Inline styles only — the file should open
 *  cleanly in any browser without external assets.
 *
 *  When `chartSnapshots` is provided and non-empty, an extra "Chart
 *  visuals" section is inserted at the top of the Charts data so the
 *  reader sees the rendered images alongside the underlying tables. */
export function buildHtmlFile(
  bundle: ExportBundle,
  sections: ExportSections,
  chartSnapshots?: ChartSnapshot[],
): BuiltFile {
  const parts: string[] = []
  if (sections.charts && bundle.charts) {
    if (chartSnapshots && chartSnapshots.length > 0) {
      parts.push(renderChartImagesSection(chartSnapshots))
    }
    parts.push(renderChartsHtmlSection(bundle.charts))
  }
  if (sections.usage && bundle.usage) parts.push(renderUsageSection(bundle.usage))
  if (sections.audit && bundle.audit) parts.push(renderAuditSection(bundle.audit))

  // Inline CSS keeps the export single-file. Numbers right-align in
  // table cells so columns line up at a glance.
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Memlore — Statistics export</title>
  <style>
    body { font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           margin: 2rem; color: #111; max-width: 1100px; }
    h1 { font-size: 1.6rem; margin: 0 0 0.25rem; }
    h2 { font-size: 1.2rem; margin: 2rem 0 0.5rem; }
    h3 { font-size: 1rem; margin: 1.25rem 0 0.5rem; color: #444; }
    .meta { color: #666; margin: 0.25rem 0 1rem; font-size: 0.9rem; }
    table { border-collapse: collapse; width: 100%; margin: 0.5rem 0 1rem; font-size: 0.9rem; }
    th, td { border: 1px solid #ddd; padding: 4px 8px; text-align: left; vertical-align: top; }
    th { background: #f5f5f5; font-weight: 600; }
    td:nth-child(n+2) { text-align: right; font-variant-numeric: tabular-nums; }
    section { margin-bottom: 2rem; }
    .chart-fig { margin: 1rem 0 1.5rem; padding: 0; }
    .chart-fig figcaption { color: #444; font-size: 0.9rem; font-weight: 600; margin-bottom: 0.4rem; }
    .chart-fig img { display: block; max-width: 100%; height: auto; border: 1px solid #e5e5e5;
                     border-radius: 6px; background: #fff; }
  </style>
</head>
<body>
  <h1>Memlore — Statistics export</h1>
  <p class="meta">Generated ${esc(bundle.generatedAt)}</p>
  ${parts.join('\n')}
</body>
</html>
`
  return {
    name: 'memlore-stats.html',
    mime: 'text/html;charset=utf-8',
    bytes: TEXT_ENCODER.encode(html),
  }
}
