# Download statistics — setup guide

How to count app downloads over time, by version and by country, **without
adding any telemetry to the app itself**. A Cloudflare Worker sits in front of
the GitHub release asset, records the hit, and redirects. The app ships
unchanged and still sends nothing.

Written so this can be rebuilt from scratch on a new machine, or copied into
another project. Implementation lives in `workers/stats/`.

## What you get

| Endpoint | Behaviour                                                                                                                    |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `/mac`   | Records `{minute, version, country}`, then 302s to the current `.dmg`. `HEAD` gets the same redirect but is **not** counted. |
| `/`      | 302 to the marketing site.                                                                                                   |
| `/stats` | HTML tables. 404 unless the access key matches.                                                                              |
| cron     | Daily snapshot of GitHub's cumulative `download_count` for every asset.                                                      |

Two tables answer two different questions — never add them together:

- `downloads` — people who clicked the website button. **Has country.** Blind to
  anyone downloading straight from the GitHub Releases page.
- `snapshots` — **all** downloads including direct GitHub ones, per version. No
  country.

Cost: free. Workers is 100k requests/day, D1 is 5 GB with 100k writes/day.

## Prerequisites

- A domain whose DNS is on Cloudflare. It can stay DNS-only — you do **not**
  need to proxy the apex, and the marketing site can keep living on GitHub Pages
  untouched. The Worker gets its own subdomain via Workers Custom Domains.
- `wrangler` as a devDependency. Nothing to install globally.
- Releases published on GitHub with deterministic asset names.

## 1. Log in (you, once per machine)

```sh
pnpm exec wrangler login   # opens a browser, click Allow
pnpm exec wrangler whoami  # must print an email and Account ID
```

## 2. Create the database and deploy

```sh
pnpm exec wrangler d1 create <db-name>
# paste the printed database_id into workers/stats/wrangler.toml
pnpm stats:schema                                                  # creates the tables
pnpm exec wrangler secret put STATS_KEY --config workers/stats/wrangler.toml
pnpm stats:deploy
```

Cloudflare creates the DNS record for the Worker's subdomain itself.

Verify:

```sh
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://<sub>.<domain>/mac
```

Expect `302` with a `location` pointing at your GitHub release asset. First
deploy can take a few minutes for DNS to propagate.

## 3. Gate `/stats` with Cloudflare Access (you, in the dashboard)

`STATS_KEY` alone is a default-deny guard, not a security boundary. Put Access
in front of the page.

Dashboard → **Zero Trust** (pick the **Free** plan on first visit) →
**Access controls → Applications → Add an application → Self-hosted**.

**Destinations → Public hostnames** — fill all three:

| Field     | Value          |
| --------- | -------------- |
| Subdomain | your subdomain |
| Domain    | your domain    |
| **Path**  | `stats`        |

> **The Path field is the one that matters.** It is labelled _(optional)_, so it
> is easy to skip — but leaving it blank locks the **whole** hostname, which
> takes the public download route down with it. Check the **Preview** panel: the
> destination must read `<sub>.<domain>/stats`, not `<sub>.<domain>`.

Leave _Allow access through browser-based RDP, SSH, or VNC_ **Off**.

**Access policies → Create new policy**: under **Include**, pick the `Emails`
selector and add the addresses that may view the page. Name it, Action `Allow`,
session duration `Same as application`. Leave MFA override and just-in-time
access Off, and ignore the whole **Connection settings** block — it sits under
a _Remote Desktop Protocol_ heading and only applies to RDP sessions.

**Authentication**: `Accept all available identity providers` On. With no
identity provider configured, Cloudflare falls back to a one-time PIN emailed to
the address — enough, no Google setup needed.

Give the application a recognisable **Name** (Cloudflare defaults to the
subdomain), then **Create**.

Verify **both**, in a private window:

```sh
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://<sub>.<domain>/mac
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://<sub>.<domain>/stats
```

- `/mac` → 302 to GitHub. Still public.
- `/stats` → 302 to `<team>.cloudflareaccess.com/cdn-cgi/access/login/…`. Gated.

If `/mac` is also pushed to the login page, the Path field is empty. Fix it
immediately — the download button is dead for everyone until you do.

## 4. Point the website at it

Export the Worker URL next to your existing GitHub URL, and use it for the
download button only. Keep the plain GitHub URL for "view the repo" links.

If every download button renders through one shared component, this is a
one-line change. Check for buttons that bypass it, and for server-side
prerendering that may emit a stale href.

**Update the privacy policy in the same change.** State what is recorded (time,
version, inferred country), what is not (no IP, no cookie), and that it happens
on download, not during app use. Pin it with a test if other copy is pinned.

## 5. Read the numbers

```sh
pnpm stats:downloads   # by day
pnpm stats:countries   # by country, split by version
pnpm stats:versions    # totals per version, includes direct GitHub downloads
pnpm stats:launches    # approximate app launches
```

Or open `https://<sub>.<domain>/stats?key=<STATS_KEY>` in a browser. A browser
cannot send a custom header from a bookmark, which is why the key is accepted in
the query string; the page replies with `cache-control: no-store, private` and
`referrer-policy: no-referrer` so it cannot leak through caches or `Referer`.
Scripts should send `X-Stats-Key` instead and keep the key out of the URL.

## Traps worth knowing

Each of these cost real debugging time.

- **`--remote` is mandatory** on every `wrangler d1 execute`. Without it you
  query an empty _local_ database and get zero rows back — indistinguishable
  from "nothing is being recorded". All `stats:*` scripts carry the flag.
- **Resolve the version from `latest.json`, not `api.github.com`.** The API is
  60 requests/hour per IP and Worker egress IPs are shared. The release
  `latest.json` is served through the CDN with no such limit. Validate the
  version string against a strict regex before interpolating it into a URL.
- **`platforms[].url` in a Tauri `latest.json` is not the installer.** It points
  at an `api.github.com` asset id for the updater bundle. Compose the `.dmg` URL
  from the `version` field instead.
- **The download button must never dead-end.** Any resolve failure — non-OK
  response, bad JSON, or a hung connection — has to fall back to a redirect to
  the Releases page. A `try/catch` alone does not cover a hang: add
  `AbortSignal.timeout(...)` to the fetch.
- **Answer `HEAD` but do not count it.** HTTP requires HEAD wherever GET is
  supported, and link checkers use it. Counting it lets probes inflate the
  numbers.
- **Snapshots are cumulative.** GitHub's `download_count` only ever grows, so a
  per-day figure is a `LAG(...) OVER (PARTITION BY … ORDER BY day)` delta. Also
  emit a day-gap column — a missed cron run otherwise presents two days of
  activity as one, silently.
- **404 on a wrong key, not 401.** A 401 confirms the path exists. Return 404
  when the secret is unset too, so deploying before Access is configured leaks
  nothing.
- **Adding `wrangler` can break `pnpm install --frozen-lockfile`** on a clean
  checkout, with `ERR_PNPM_IGNORED_BUILDS` for `esbuild` and `workerd`. Declare
  them under `allowBuilds:` in `pnpm-workspace.yaml`. Both are safe to skip:
  bundling and remote deploys work without their postinstall scripts.
- **The Worker's tsconfig must set `"lib": ["ESNext"]` with no `DOM`.**
  `@cloudflare/workers-types` redeclares `Request`/`Response`/`Headers`, so the
  default lib produces dozens of duplicate-declaration errors. Keep
  Node-dependent test files outside the tsconfig's `include`, or Node globals
  start typechecking in Worker code that has no `nodejs_compat`.
- **Do not put the Worker in the updater's path.** If the app checks for updates
  against GitHub, leave it there. Routing it through the Worker means a Worker
  outage stops updates on every installed device.
- **Website changes only go live on the deploying branch.** Check the deploy
  workflow's trigger. Until you merge, the live button still points at GitHub
  and the table stays at 0 — which reads exactly like a broken setup.

## Why no in-app telemetry

The honest limit of this approach: it counts _downloads_, not _users_. It cannot
tell one person downloading twice from two people downloading once, and the
"launches" figure is only a by-product of the updater's once-per-launch check.

Getting real user counts requires the app to phone home. That was a deliberate
no — so the privacy promise stays intact, and the only thing ever recorded is a
download that already had to touch a public CDN.
