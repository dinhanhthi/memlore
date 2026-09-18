import { FALLBACK_URL, LATEST_JSON_URL, REPO, dmgUrl, versionFromLatestJson } from './releases'
import { renderStats } from './stats'

export interface Env {
  DB: D1Database
  STATS_KEY?: string
}

// Only the daily cron touches api.github.com (60 req/hr per IP, and Worker
// egress IPs are shared). per_page=100 because the default 30 would silently
// truncate the snapshot once there are more than 30 releases.
const GH_RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=100`

const TEXT = { 'content-type': 'text/plain; charset=utf-8' }

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: TEXT })
}

function redirect(location: string): Response {
  // Not Response.redirect(): its headers are immutable, and this response must
  // carry no-store or an intermediary caches a version URL that outlives the
  // release it points at.
  return new Response(null, {
    status: 302,
    headers: { location, 'cache-control': 'no-store' },
  })
}

/** Resolves the current version, or null so the caller can fall back. */
async function resolveVersion(): Promise<string | null> {
  try {
    const res = await fetch(LATEST_JSON_URL, {
      cf: { cacheEverything: true, cacheTtl: 300 },
      // A hung CDN connection is the one "GitHub down" mode that neither the
      // try/catch nor the !res.ok check covers: without this, /mac blocks here
      // and the visitor gets Cloudflare's timeout page instead of the fallback.
      // The AbortError lands in the catch below and becomes FALLBACK_URL.
      signal: AbortSignal.timeout(2000),
    })
    if (!res.ok) return null
    return versionFromLatestJson(await res.json())
  } catch {
    return null
  }
}

/**
 * One row per redirect. Country only — never the IP address, never a cookie.
 * `ts` is truncated to the minute: no query reads finer than `day`, and an exact
 * instant is the one field with enough join-power to match a Cloudflare edge log
 * line (which does carry an IP) back to a single person.
 *
 * `async` + a try/catch around the whole body, not a trailing `.catch()`: a
 * synchronous throw (a missing D1 binding makes `env.DB.prepare` throw while
 * `ctx.waitUntil(...)`'s argument is being evaluated) would escape `handleMac`
 * and turn the redirect into a 500.
 */
export async function logDownload(env: Env, version: string, country: string): Promise<void> {
  try {
    const ts = new Date().toISOString()
    await env.DB.prepare(
      'INSERT INTO downloads (ts, day, version, country, platform) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(`${ts.slice(0, 16)}:00Z`, ts.slice(0, 10), version, country, 'mac')
      .run()
  } catch (err) {
    console.error('downloads insert failed', err)
  }
}

/**
 * Default-deny: no STATS_KEY configured means /stats does not exist, so
 * deploying before Cloudflare Access is set up leaks nothing.
 */
export function authorized(request: Request, url: URL, env: Env): boolean {
  const secret = env.STATS_KEY
  if (!secret) return false
  // A browser cannot send a custom header from a bookmark, so `?key=` stays the
  // route for viewing the page. It does land in browser history and Cloudflare
  // access logs, which is why Cloudflare Access — not this key — is the real
  // gate; see workers/stats/README.md. Scripts should use the header instead.
  const given = request.headers.get('x-stats-key') ?? url.searchParams.get('key')
  if (given === null) return false
  const a = new TextEncoder().encode(given)
  const b = new TextEncoder().encode(secret)
  // timingSafeEqual throws on differing lengths, so length is checked first.
  // Length is not a secret; the key material is.
  if (a.byteLength !== b.byteLength) return false
  return crypto.subtle.timingSafeEqual(a, b)
}

async function handleMac(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const version = await resolveVersion()
  // Country only, straight off Cloudflare's edge metadata. Nothing else on
  // `request.cf` is read, and the IP is never touched.
  const cfCountry: unknown = request.cf?.country
  const country = typeof cfCountry === 'string' ? cfCountry : 'XX'
  // waitUntil: the insert must never delay the redirect.
  ctx.waitUntil(logDownload(env, version ?? 'unknown', country))
  return redirect(version ? dmgUrl(version) : FALLBACK_URL)
}

interface GhAsset {
  name?: unknown
  download_count?: unknown
}

interface GhRelease {
  tag_name?: unknown
  assets?: unknown
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'GET') return text('Method not allowed', 405)

    const url = new URL(request.url)
    switch (url.pathname) {
      case '/mac':
        return handleMac(request, env, ctx)
      case '/':
        return redirect('https://memlore.app')
      case '/stats':
        // 404, not 401: a wrong key must not confirm the path exists.
        return authorized(request, url, env) ? renderStats(env.DB) : text('Not found', 404)
      default:
        return text('Not found', 404)
    }
  },

  async scheduled(_controller, env, _ctx) {
    const res = await fetch(GH_RELEASES_API, {
      // GitHub rejects requests without a User-Agent.
      headers: { 'user-agent': 'memlore-stats-worker', accept: 'application/vnd.github+json' },
    })
    if (!res.ok) {
      // Returning without writing: a partial snapshot would corrupt every delta.
      console.error('github releases fetch failed', res.status, await res.text())
      return
    }

    const releases = (await res.json()) as unknown
    if (!Array.isArray(releases)) {
      console.error('github releases: unexpected payload shape')
      return
    }

    const day = new Date().toISOString().slice(0, 10)
    const insert = env.DB.prepare(
      'INSERT OR REPLACE INTO snapshots (day, tag, asset, count) VALUES (?, ?, ?, ?)',
    )
    const statements: D1PreparedStatement[] = []

    for (const release of releases as GhRelease[]) {
      const tag = release?.tag_name
      if (typeof tag !== 'string' || !Array.isArray(release.assets)) continue
      // Every asset, including latest.json and the .sig files: latest.json's
      // delta is the only app-launch signal that exists.
      for (const asset of release.assets as GhAsset[]) {
        const name = asset?.name
        const count = asset?.download_count
        // Number.isInteger, not typeof: `1e400` parses as Infinity and NaN is a
        // number too, and both would go into an `INTEGER NOT NULL` column.
        if (typeof name !== 'string' || !Number.isInteger(count)) continue
        statements.push(insert.bind(day, tag, name, count))
      }
    }

    if (statements.length === 0) {
      console.error('github releases: no assets found, nothing written')
      return
    }
    await env.DB.batch(statements)
  },
} satisfies ExportedHandler<Env>
