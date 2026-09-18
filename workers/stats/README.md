# memlore-stats — download counter Worker

A Cloudflare Worker on `dl.memlore.app` that redirects the website's Download
button to the current `.dmg`, logs each redirect into D1, and snapshots GitHub's
cumulative download counters once a day. A password-gated `/stats` page renders
the numbers.

**No in-app telemetry.** Nothing under `src/` or `src-tauri/` is involved, the
app sends nothing, and the updater keeps pointing straight at GitHub. This
Worker only sees people who click Download on the website, plus whatever GitHub's
public release counters already report.

## Routes

| Route    | Behaviour                                                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `/mac`   | 302 to `Memlore_<version>_universal.dmg`, resolved from `latest.json` (cached 300s). Logs one row.                                 |
| `/`      | 302 to `https://memlore.app`.                                                                                                      |
| `/mac`   | 302 to the current `.dmg`. `HEAD` gets the same redirect but is not counted — link checkers and bots must not inflate the numbers. |
| `/stats` | HTML tables. **404** unless `STATS_KEY` is set _and_ `?key=` (or the `X-Stats-Key` header) matches it.                             |
| anything | 404. Non-GET on any route: 405.                                                                                                    |

If version resolution fails for any reason — GitHub down, non-OK response, bad
JSON, a hung connection (the `latest.json` fetch carries a 2 s
`AbortSignal.timeout`), a `version` value that fails the
`/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/` guard — `/mac` still 302s, to
`https://github.com/dinhanhthi/memlore/releases/latest`. The Download button
degrades to the Releases page; it never dies.

Nothing personal is stored: no IP address, no cookie, no identifier. The only
per-request field kept is `request.cf.country` (`XX` when Cloudflare supplies
none). The timestamp is truncated to the minute — nothing queries finer than the
day, and a to-the-second instant is precise enough to join a row against a
Cloudflare edge log line that does carry an IP.

## Setup (run these yourself, in this order)

```bash
pnpm install

# 1. Authenticate.
pnpm exec wrangler login

# 2. Create the database. This prints a database_id.
pnpm exec wrangler d1 create memlore-stats

# 3. Paste that id into workers/stats/wrangler.toml, replacing
#    database_id = "PASTE_FROM_wrangler_d1_create"
#    It is a placeholder until this step — only Cloudflare can produce it, and
#    deploy fails with an unhelpful error while it is still the placeholder.

# 4. Create the tables (safe to re-run, every statement is IF NOT EXISTS).
pnpm stats:schema

# 5. Set the /stats password. Until this exists, /stats returns 404.
pnpm exec wrangler secret put STATS_KEY --config workers/stats/wrangler.toml

# 6. Deploy.
pnpm stats:deploy
```

The custom domain `dl.memlore.app` comes from `routes` in `wrangler.toml`; the
apex `memlore.app` stays DNS-only on GitHub Pages and is not touched.

Wrangler itself sends anonymous usage telemetry (the CLI, not the app). Turn it
off once with `pnpm exec wrangler telemetry disable`, or export
`WRANGLER_SEND_METRICS=false`.

`snapshots` stays empty until the cron first runs at 00:00 UTC, so check
`pnpm stats:versions` the day after deploying rather than straight away. Do
**not** reach for `wrangler dev --test-scheduled` to hurry it along: dev runs
local by default, so `/__scheduled` would write into a throwaway local database
that has never had `schema.sql` applied — nothing reaches production and it
reads like the cron is broken. `downloads` needs no cron; it fills from the
first `/mac` click.

## Reading the data

```bash
pnpm stats:downloads   # website redirects per day, last 90 days
pnpm stats:countries   # website redirects by country
pnpm stats:versions    # cumulative .dmg totals, all sources
pnpm stats:launches    # approximate daily launches (latest.json delta)
```

**`--remote` is mandatory and every script above carries it.** Without it,
`wrangler d1 execute` queries a _local_ dev database that has never seen a
single request and returns zero rows — which reads exactly like "the system is
logging nothing". If a query ever comes back empty, check for `--remote` before
anything else.

The same SQL lives in `queries/*.sql` as real files, so they also work with
`wrangler d1 execute --file=` directly, and the `/stats` page uses byte-identical
strings.

## The two data sources answer different questions

Never add them together.

- **`downloads`** — the website redirect log. One row per `/mac` hit, so it has
  a country and a minute-precision timestamp. **Blind spot:** someone who downloads
  straight from the GitHub Releases page, or from a link shared elsewhere, is
  completely invisible here.
- **`snapshots`** — a daily copy of GitHub's cumulative `download_count` for
  every release asset. It covers _every_ source, including the Releases page.
  **Blind spots:** no country, no per-day detail before the first cron run, and
  the value is **cumulative** — a daily figure must be derived as a
  `LAG(...) OVER (PARTITION BY tag, asset ORDER BY day)` delta, never read off
  `count`. The same query also returns `days`, the span that delta covers: `1`
  is normal, and anything higher means a cron run was skipped and that many days
  of activity are summed into the one row.

"App launches (approx.)" is the daily delta of `latest.json`'s counter, because
the updater fetches that file once per launch. It is a trend line, not a user
count: CDN caching, repeat launches on one device, and non-updater fetches all
distort it.

## Protecting /stats

Two independent layers; keep both.

**Layer 1 — `STATS_KEY` (already implemented, default-deny).** `/stats` returns
404 when the secret is unset or when `?key=` does not match it byte-for-byte
(constant-time compare). 404 rather than 401, so a wrong key does not confirm
the path exists. Bookmark:

```
https://dl.memlore.app/stats?key=<the STATS_KEY value>
```

A query-string secret lands in your browser history and in Cloudflare's access
logs. That is accepted deliberately: a browser cannot send a custom header from
a bookmark, and a bookmark is the point of this page. The response carries
`cache-control: no-store, private` and `referrer-policy: no-referrer` so it is
not cached by intermediaries and the key cannot leak through Referer. For
scripts and `curl`, send the key as a header instead and keep it out of the URL:

```sh
curl -H "X-Stats-Key: <the STATS_KEY value>" https://dl.memlore.app/stats
```

**Treat `STATS_KEY` as a guard, not as the security boundary.** It exists so
that deploying before Access is configured leaks nothing. Layer 2 is what
actually protects the page.

**Layer 2 — Cloudflare Access (your step, in the dashboard).** Zero Trust →
Access → Applications → Add a self-hosted application:

- Application domain: `dl.memlore.app`, path `stats`
- Policy: Allow → Include → Emails → `dinhanhthi@gmail.com`,
  `me@dinhanhthi.com`, `contact@memlore.app`

Access matches on the path only and ignores the query string, so the more
specific `/stats` rule leaves `/mac` public — do not add a rule for the bare
domain. Access forwards the original request including its query string, so the
login screen and the `?key=` check stack rather than replace each other.

**Unverified, check when you set it up:** the Zero Trust free-tier seat limit,
and whether Access can attach to a Workers _custom domain_ (as opposed to a
proxied DNS record). If either blocks it, `STATS_KEY` alone is the documented
fallback and `/stats` stays closed by default either way.

## Files

| File              | What it is                                                              |
| ----------------- | ----------------------------------------------------------------------- |
| `wrangler.toml`   | Worker name, route, D1 binding, daily cron.                             |
| `schema.sql`      | The two tables. Idempotent.                                             |
| `src/releases.ts` | Pure version/URL helpers, including the version-string guard.           |
| `src/index.ts`    | `fetch` (routing, redirect, logging) and `scheduled` (daily snapshot).  |
| `src/stats.ts`    | The `/stats` HTML renderer and the SQL it runs.                         |
| `queries/*.sql`   | Saved queries for `pnpm stats:*`.                                       |
| `queries.test.ts` | Parity guard: each `queries/*.sql` must equal its string in `stats.ts`. |

Typecheck and test from the repo root:

```bash
pnpm stats:typecheck
pnpm test          # src/{releases,index}.test.ts + queries.test.ts
pnpm lint
```

`workers/stats/tsconfig.json` is standalone — it is deliberately not referenced
from the root `tsconfig.json`, and its `lib` is `["ESNext"]` without `DOM`
because `@cloudflare/workers-types` redeclares `Request`/`Response`/`Headers`.
