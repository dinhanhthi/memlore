import type { StatsChartsBundle } from '../../hooks/useStatsExportData'
import { toCsv } from './csv'
import type { BuiltFile } from './types'

const TEXT_ENCODER = new TextEncoder()

function csv(name: string, text: string): BuiltFile {
  return { name, mime: 'text/csv;charset=utf-8', bytes: TEXT_ENCODER.encode(text) }
}

// ─── Per-chart CSV files ──────────────────────────────────────────────────────

/** Produce one CSV per chart so each file has stable, semantic
 *  columns. The wrapper combines these (and any usage / audit CSVs)
 *  into a single zip when more than one section is selected. */
export function buildChartsCsvs(charts: StatsChartsBundle): BuiltFile[] {
  return [
    csv(
      'charts/entries-over-time.csv',
      toCsv(
        ['period_start', 'count'],
        charts.entries_over_time.map((p) => [p.period_start, p.count]),
      ),
    ),
    csv(
      'charts/writing-volume.csv',
      toCsv(
        ['period_start', 'total_words', 'entry_count'],
        charts.writing_volume.map((p) => [p.period_start, p.total_words, p.entry_count]),
      ),
    ),
    csv(
      'charts/mood-histogram.csv',
      toCsv(
        ['emotion', 'count'],
        charts.mood_histogram.map((r) => [r.emotion, r.count]),
      ),
    ),
    csv(
      'charts/mood-trend.csv',
      toCsv(
        ['day', 'sample_count'],
        charts.mood_trend.map((p) => [p.day, p.sample_count]),
      ),
    ),
    csv(
      'charts/tag-frequency.csv',
      toCsv(
        ['tag_id', 'tag_name', 'count'],
        charts.tag_frequency.map((t) => [t.tag_id, t.tag_name, t.count]),
      ),
    ),
    csv(
      'charts/streak-calendar.csv',
      toCsv(
        ['date', 'entry_count'],
        charts.streak_calendar.map((d) => [d.date, d.entry_count]),
      ),
    ),
    csv(
      'charts/location-density.csv',
      toCsv(
        ['lat', 'lng', 'count'],
        charts.location_density.map((p) => [p.lat, p.lng, p.count]),
      ),
    ),
  ]
}

// ─── HTML section (consumed by html.ts) ───────────────────────────────────────

function esc(v: unknown): string {
  if (v == null) return ''
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function htmlTable(headers: string[], rows: Array<Array<string | number | null>>): string {
  const thead = `<thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>`
  const tbody = `<tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
    .join('')}</tbody>`
  return `<table>${thead}${tbody}</table>`
}

export function renderChartsHtmlSection(charts: StatsChartsBundle): string {
  const eot = htmlTable(
    ['Period start', 'Count'],
    charts.entries_over_time.map((p) => [p.period_start, p.count]),
  )
  const wv = htmlTable(
    ['Period start', 'Total words', 'Entry count'],
    charts.writing_volume.map((p) => [p.period_start, p.total_words, p.entry_count]),
  )
  const mh = htmlTable(
    ['Emotion', 'Count'],
    charts.mood_histogram.map((r) => [r.emotion, r.count]),
  )
  const mt = htmlTable(
    ['Day', 'Sample count'],
    charts.mood_trend.map((p) => [p.day, p.sample_count]),
  )
  const tf = htmlTable(
    ['Tag ID', 'Tag name', 'Count'],
    charts.tag_frequency.map((t) => [t.tag_id, t.tag_name, t.count]),
  )
  const sc = htmlTable(
    ['Date', 'Entry count'],
    charts.streak_calendar.map((d) => [d.date, d.entry_count]),
  )
  const ld = htmlTable(
    ['Latitude', 'Longitude', 'Count'],
    charts.location_density.map((p) => [p.lat, p.lng, p.count]),
  )
  return `
<section>
  <h2>Charts data</h2>
  <p class="meta">Range: ${charts.rangeDays} days · Streak year: ${charts.streakYear}</p>
  <h3>Entries over time</h3>${eot}
  <h3>Writing volume</h3>${wv}
  <h3>Mood histogram</h3>${mh}
  <h3>Mood trend</h3>${mt}
  <h3>Tag frequency</h3>${tf}
  <h3>Streak calendar</h3>${sc}
  <h3>Location density</h3>${ld}
</section>`
}
