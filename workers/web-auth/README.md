# memlore-web-auth - OAuth code-exchange Worker

A Cloudflare Worker on `web.memlore.app/api/*` that keeps the Google OAuth
client secret and the Drive refresh token out of the browser. The web app holds
only a short-lived access token in memory. The refresh token lives in an
encrypted, HttpOnly cookie the page's JavaScript cannot read.

No KV, no D1, no logging of tokens, bodies or state. Errors are generic.

## Routes

| Route                     | Behaviour                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/oauth/start`    | Seals the PKCE verifier + `state` in a 10-minute AES-GCM cookie (`ml_pkce`, `SameSite=Lax`), then 302s to Google (`drive.appdata`, offline, S256).            |
| `GET /api/oauth/callback` | Checks `state` (constant-time), exchanges the code, sets `ml_rt` (encrypted refresh token, `SameSite=Strict`, 180 days), clears `ml_pkce`, returns the page.  |
| `GET /api/oauth/done.js`  | The completion script. Separate route because the app CSP (`script-src 'self'`) blocks inline scripts.                                                        |
| `POST /api/oauth/token`   | Needs `X-Memlore: 1` and an exact `Origin` match. Refreshes at Google, returns `{access_token, expires_in}`. `invalid_grant` clears the cookie, 401 `reauth`. |
| `POST /api/oauth/logout`  | Same checks. Revokes the refresh token at Google (best effort) and clears `ml_rt`.                                                                            |
| `GET /api/config`         | `{ "writes": true }` only when `WEB_WRITES_ENABLED` is exactly `"1"`. Anything else (including unset) is `false`.                                             |

The completion page posts `{ type: "memlore-oauth-done" }` (or
`{ type: "memlore-oauth-error" }`, no detail) on `BroadcastChannel("memlore-oauth")`
and closes itself. It does not use `window.opener`, because Google's COOP header
usually severs it.

Both cookies are `HttpOnly; Secure; Path=/api/oauth`. `ml_pkce` is `Lax` because
`Strict` is not sent on the cross-site redirect back from Google.

## Configuration

`wrangler.toml` `[vars]`: `APP_ORIGIN` (`https://web.memlore.app`, overridden to
`http://localhost:5176` under `[env.dev]`) and `WEB_WRITES_ENABLED` (`"0"`).
`redirect_uri` is always `${APP_ORIGIN}/api/oauth/callback`.

Secrets, set with `wrangler secret put` and never committed:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `COOKIE_KEY` - base64 of 32 random bytes (`openssl rand -base64 32`). A key of any other length is rejected.

For local dev, put the same three keys in `workers/web-auth/.dev.vars` (gitignored), then run
`pnpm web-auth:dev` (it uses `--env dev`) next to `pnpm web:dev`, or next to
`pnpm web:build && pnpm web:preview` for the production bundle. Add `--var WEB_WRITES_ENABLED:1` to test writes.

See `docs/plans/2026-10-02-web-app/setup-guide.md` for the full walkthrough.

## Security assumptions

- The sealed cookies (`ml_pkce`, `ml_rt`) use `Path=/api/oauth` and no `__Host-` prefix. A
  compromised sibling subdomain of `memlore.app` could therefore toss cookies at this origin
  (login CSRF) for the 10-minute PKCE window. `__Host-` requires `Path=/` and no `Domain`, and was
  not adopted. Mitigation: keep every `memlore.app` subdomain trusted.
- There is no rate limiting on `/start`, `/callback`, `/token` or `/logout`. Cloudflare WAF
  rate-limiting rules are recommended in front of the Worker.

## Local development

In dev the Worker is reached through the Vite proxy (`web/vite.config.ts` proxies
`/api` to `http://localhost:8787`), never `:8787` directly, so `redirect_uri` is
`http://localhost:5176/api/oauth/callback`.

`Secure` is always set. Safari may drop `Secure` cookies on `http://localhost`, so
use Chrome or Firefox for local OAuth.

## Typecheck

```bash
pnpm exec tsc -p workers/web-auth/tsconfig.json --noEmit
```
