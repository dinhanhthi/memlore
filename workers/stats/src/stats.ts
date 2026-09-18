// The /stats page: one hand-written HTML document, no framework, no external
// assets. Each SQL string here is byte-identical to the matching file in
// ../queries/ (minus its leading `--` comment header) so the page and
// `pnpm stats:*` can never drift apart.

const DOWNLOADS_BY_DAY = `SELECT day, version, COUNT(*) AS downloads
FROM downloads
WHERE day >= date('now', '-90 days')
GROUP BY day, version
ORDER BY day DESC, version;`

const DOWNLOADS_BY_COUNTRY = `SELECT country, version, COUNT(*) AS downloads
FROM downloads
GROUP BY country, version
ORDER BY downloads DESC, country, version;`

const TOTALS_BY_VERSION = `SELECT s.tag, s.asset, s.count AS total, s.day AS as_of
FROM snapshots s
WHERE s.asset LIKE '%.dmg'
  AND s.day = (SELECT MAX(day) FROM snapshots n WHERE n.tag = s.tag AND n.asset = s.asset)
ORDER BY s.tag DESC, s.asset;`

// snapshots.count is GitHub's CUMULATIVE counter, so the daily figure is a LAG
// delta. Reading `count` straight would report the running total instead.
// `days` is the span the delta covers: a skipped cron run merges two days of
// activity into one row, and without this column nothing in the output says so.
const LAUNCHES_BY_DAY = `SELECT day, tag, launches, days
FROM (
  SELECT day, tag,
         count - LAG(count) OVER (PARTITION BY tag, asset ORDER BY day) AS launches,
         CAST(
           julianday(day) - julianday(LAG(day) OVER (PARTITION BY tag, asset ORDER BY day))
           AS INTEGER
         ) AS days
  FROM snapshots
  WHERE asset = 'latest.json'
)
WHERE launches IS NOT NULL
ORDER BY day DESC, tag;`

/**
 * Keyed by the file in ../queries/ each string has to match. The parity test in
 * ../queries.test.ts is the only thing that actually enforces the "byte-identical"
 * claim at the top of this file -- keep both sides in one commit.
 */
export const QUERIES: Record<string, string> = {
  'downloads-by-day.sql': DOWNLOADS_BY_DAY,
  'downloads-by-country.sql': DOWNLOADS_BY_COUNTRY,
  'totals-by-version.sql': TOTALS_BY_VERSION,
  'launches-by-day.sql': LAUNCHES_BY_DAY,
}

interface Section {
  title: string
  caption: string
  sql: string
}

// Four questions, four sources. The website log and GitHub's counters answer
// different things and must never be presented as one number.
const SECTIONS: Section[] = [
  {
    title: 'Downloads by day (website only)',
    caption:
      'Source: dl.memlore.app/mac redirects, last 90 days. Blind spot: a download taken straight from the GitHub Releases page is not counted here.',
    sql: DOWNLOADS_BY_DAY,
  },
  {
    title: 'By country (website only)',
    caption:
      'Source: the same redirect log, country from Cloudflare (XX when unknown). No IP address is ever read or stored. Blind spot: same as above, website visitors only.',
    sql: DOWNLOADS_BY_COUNTRY,
  },
  {
    title: 'Total by version (all sources, incl. direct GitHub)',
    caption:
      "Source: the newest daily snapshot of GitHub's cumulative download_count per .dmg asset. Blind spot: no country, and nothing before the first cron run.",
    sql: TOTALS_BY_VERSION,
  },
  {
    title: 'App launches (approx.)',
    caption:
      'Approximation: the updater fetches latest.json once per launch, so this is the day-over-day delta of its download_count. The snapshot runs at 00:00 UTC, so the row for day D reflects activity on day D-1. CDN caching and repeat launches distort it — read it as a trend, not a user count. `days` is the span the delta covers: 1 is normal, more means a cron run was skipped and that many days were merged into the row.',
    sql: LAUNCHES_BY_DAY,
  },
]

/** Every cell comes from GitHub or Cloudflare, so nothing is interpolated raw. */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function table(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '<p class="empty">No rows yet.</p>'
  const columns = Object.keys(rows[0])
  const head = columns.map((c) => `<th>${esc(c)}</th>`).join('')
  const body = rows
    .map((row) => `<tr>${columns.map((c) => `<td>${esc(row[c])}</td>`).join('')}</tr>`)
    .join('')
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
}

async function section(db: D1Database, { title, caption, sql }: Section): Promise<string> {
  let content: string
  try {
    const { results } = await db.prepare(sql).all<Record<string, unknown>>()
    content = table(results ?? [])
  } catch (err) {
    content = `<p class="empty">Query failed: ${esc(err instanceof Error ? err.message : err)}</p>`
  }
  return `<section><h2>${esc(title)}</h2><p class="caption">${esc(caption)}</p>${content}</section>`
}

export async function renderStats(db: D1Database): Promise<Response> {
  const sections = await Promise.all(SECTIONS.map((s) => section(db, s)))
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Memlore download stats</title>
<style>
:root { color-scheme: light dark }
body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 2rem auto; max-width: 60rem; padding: 0 1rem }
h1 { font-size: 1.4rem }
h2 { font-size: 1.05rem; margin: 2rem 0 .25rem }
.caption, .empty { color: #6b7280; font-size: .82rem; margin: .25rem 0 .75rem }
table { border-collapse: collapse; width: 100% }
th, td { border-bottom: 1px solid #9ca3af59; padding: .3rem .5rem; text-align: left }
td:last-child, th:last-child { text-align: right }
</style>
</head>
<body>
<h1>Memlore download stats</h1>
<p class="caption">Generated ${esc(new Date().toISOString())}. No personal data is collected: no IP, no cookie, no identifier.</p>
${sections.join('\n')}
</body>
</html>
`
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // The key may arrive in the query string, so keep this response out of
      // shared caches and stop it leaking through Referer on any outbound click.
      'cache-control': 'no-store, private',
      'referrer-policy': 'no-referrer',
      // Belt to esc()'s braces: no script, no image, no fetch can run from this
      // document even if a future escaping bug lets markup through.
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    },
  })
}
