import {
  importCookieKey,
  open,
  parseCookies,
  seal,
  serializeCookie,
  timingSafeEqual,
  toBase64Url,
} from './session'

export interface Env {
  APP_ORIGIN: string
  WEB_WRITES_ENABLED?: string
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  COOKIE_KEY: string
}

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata'

const COOKIE_PATH = '/api/oauth'
const PKCE_COOKIE = 'ml_pkce'
const RT_COOKIE = 'ml_rt'
const PKCE_TTL_S = 10 * 60
const RT_TTL_S = 180 * 24 * 60 * 60

const DONE_JS = `(function () {
  var ok = document.body.getAttribute("data-result") === "done";
  var ch = new BroadcastChannel("memlore-oauth");
  ch.postMessage({ type: ok ? "memlore-oauth-done" : "memlore-oauth-error" });
  ch.close();
  window.close();
})();
`

// frame-ancestors is not covered by default-src, so it is listed explicitly.
const PAGE_CSP = "default-src 'none'; script-src 'self'; frame-ancestors 'none'"

function hardened(headers: Headers): Headers {
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Referrer-Policy', 'no-referrer')
  return headers
}

function json(body: unknown, status = 200, extra?: Headers): Response {
  const headers = hardened(new Headers(extra))
  headers.set('Content-Type', 'application/json')
  headers.set('Cache-Control', 'no-store')
  return new Response(JSON.stringify(body), { status, headers })
}

function completionPage(ok: boolean, cookies: string[]): Response {
  const headers = hardened(
    new Headers({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': PAGE_CSP,
      'Cache-Control': 'no-store',
    }),
  )
  for (const c of cookies) headers.append('Set-Cookie', c)
  const body =
    `<!doctype html><html><head><meta charset="utf-8"><title>Memlore</title></head>` +
    `<body data-result="${ok ? 'done' : 'error'}"><script src="/api/oauth/done.js"></script></body></html>`
  return new Response(body, { status: ok ? 200 : 400, headers })
}

const clearCookie = (name: string, sameSite: 'Lax' | 'Strict'): string =>
  serializeCookie(name, '', { maxAge: 0, path: COOKIE_PATH, sameSite })

function randomToken(bytes: number): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)))
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return toBase64Url(new Uint8Array(digest))
}

function isSealedPkce(v: unknown): v is { state: string; verifier: string } {
  const o = v as { state?: unknown; verifier?: unknown } | null
  return !!o && typeof o.state === 'string' && typeof o.verifier === 'string'
}

function isSealedRt(v: unknown): v is { rt: string } {
  return typeof (v as { rt?: unknown } | null)?.rt === 'string'
}

/** State-changing endpoints: exact Origin match plus the custom header. */
function isTrustedPost(request: Request, env: Env): boolean {
  return (
    request.headers.get('Origin') === env.APP_ORIGIN && request.headers.get('X-Memlore') === '1'
  )
}

async function postForm(
  fetchImpl: FetchImpl,
  url: string,
  params: Record<string, string>,
): Promise<Response> {
  return fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  })
}

async function handleStart(env: Env): Promise<Response> {
  const key = await importCookieKey(env.COOKIE_KEY)
  if (!key || !env.GOOGLE_CLIENT_ID) return json({ error: 'server' }, 500)
  const state = randomToken(32)
  const verifier = randomToken(48)
  const cookie = await seal(key, 'pkce', { state, verifier }, PKCE_TTL_S)
  const url = new URL(GOOGLE_AUTH_URL)
  url.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${env.APP_ORIGIN}/api/oauth/callback`,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    code_challenge: await s256(verifier),
    code_challenge_method: 'S256',
    state,
  }).toString()
  // Lax, not Strict: Strict is not sent on the cross-site redirect back from accounts.google.com.
  const headers = hardened(new Headers({ Location: url.toString(), 'Cache-Control': 'no-store' }))
  headers.append(
    'Set-Cookie',
    serializeCookie(PKCE_COOKIE, cookie, {
      maxAge: PKCE_TTL_S,
      path: COOKIE_PATH,
      sameSite: 'Lax',
    }),
  )
  return new Response(null, { status: 302, headers })
}

async function handleCallback(request: Request, env: Env, fetchImpl: FetchImpl): Promise<Response> {
  const clearPkce = clearCookie(PKCE_COOKIE, 'Lax')
  const fail = () => completionPage(false, [clearPkce])
  const key = await importCookieKey(env.COOKIE_KEY)
  if (!key) return fail()
  const params = new URL(request.url).searchParams
  const code = params.get('code')
  const state = params.get('state')
  const sealed = parseCookies(request.headers.get('Cookie')).get(PKCE_COOKIE)
  if (!code || !state || !sealed) return fail()
  const pkce = await open(key, 'pkce', sealed)
  if (!isSealedPkce(pkce) || !timingSafeEqual(pkce.state, state)) return fail()

  let refreshToken: unknown
  try {
    const res = await postForm(fetchImpl, GOOGLE_TOKEN_URL, {
      grant_type: 'authorization_code',
      code,
      code_verifier: pkce.verifier,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${env.APP_ORIGIN}/api/oauth/callback`,
    })
    if (!res.ok) return fail()
    refreshToken = ((await res.json()) as { refresh_token?: unknown }).refresh_token
  } catch {
    return fail()
  }
  if (typeof refreshToken !== 'string' || !refreshToken) return fail()

  const rt = await seal(key, 'rt', { rt: refreshToken }, RT_TTL_S)
  return completionPage(true, [
    clearPkce,
    serializeCookie(RT_COOKIE, rt, { maxAge: RT_TTL_S, path: COOKIE_PATH, sameSite: 'Strict' }),
  ])
}

async function readRefreshToken(request: Request, env: Env): Promise<string | null> {
  const key = await importCookieKey(env.COOKIE_KEY)
  const sealed = parseCookies(request.headers.get('Cookie')).get(RT_COOKIE)
  if (!key || !sealed) return null
  const data = await open(key, 'rt', sealed)
  return isSealedRt(data) ? data.rt : null
}

function reauth(): Response {
  const headers = new Headers()
  headers.append('Set-Cookie', clearCookie(RT_COOKIE, 'Strict'))
  return json({ error: 'reauth' }, 401, headers)
}

async function handleToken(request: Request, env: Env, fetchImpl: FetchImpl): Promise<Response> {
  if (!isTrustedPost(request, env)) return json({ error: 'forbidden' }, 403)
  const rt = await readRefreshToken(request, env)
  if (!rt) return reauth()
  try {
    const res = await postForm(fetchImpl, GOOGLE_TOKEN_URL, {
      grant_type: 'refresh_token',
      refresh_token: rt,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
    })
    const body = (await res.json()) as {
      access_token?: unknown
      expires_in?: unknown
      error?: unknown
    }
    if (body.error === 'invalid_grant') return reauth()
    if (!res.ok || typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') {
      return json({ error: 'upstream' }, 502)
    }
    return json({ access_token: body.access_token, expires_in: body.expires_in })
  } catch {
    return json({ error: 'upstream' }, 502)
  }
}

async function handleLogout(request: Request, env: Env, fetchImpl: FetchImpl): Promise<Response> {
  if (!isTrustedPost(request, env)) return json({ error: 'forbidden' }, 403)
  const rt = await readRefreshToken(request, env)
  if (rt) {
    try {
      await postForm(fetchImpl, GOOGLE_REVOKE_URL, { token: rt })
    } catch {
      // Best effort: the cookie is cleared regardless.
    }
  }
  const headers = new Headers()
  headers.append('Set-Cookie', clearCookie(RT_COOKIE, 'Strict'))
  return json({ ok: true }, 200, headers)
}

function handleDoneJs(): Response {
  return new Response(DONE_JS, {
    headers: hardened(
      new Headers({
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': PAGE_CSP,
      }),
    ),
  })
}

const GET_ROUTES = new Set([
  '/api/oauth/start',
  '/api/oauth/callback',
  '/api/oauth/done.js',
  '/api/config',
])
const POST_ROUTES = new Set(['/api/oauth/token', '/api/oauth/logout'])

/** The Google-facing fetch is injectable so tests can run without network. */
export function createHandler(fetchImpl: FetchImpl = (input, init) => fetch(input, init)) {
  return async (request: Request, env: Env): Promise<Response> => {
    const { pathname } = new URL(request.url)
    if (!GET_ROUTES.has(pathname) && !POST_ROUTES.has(pathname))
      return json({ error: 'not_found' }, 404)
    const method = GET_ROUTES.has(pathname) ? 'GET' : 'POST'
    if (request.method !== method) return json({ error: 'method_not_allowed' }, 405)
    switch (pathname) {
      case '/api/oauth/start':
        return handleStart(env)
      case '/api/oauth/callback':
        return handleCallback(request, env, fetchImpl)
      case '/api/oauth/done.js':
        return handleDoneJs()
      case '/api/oauth/token':
        return handleToken(request, env, fetchImpl)
      case '/api/oauth/logout':
        return handleLogout(request, env, fetchImpl)
      default:
        // Fail closed: only the exact string "1" enables writes.
        return json({ writes: env.WEB_WRITES_ENABLED === '1' })
    }
  }
}

const handler = createHandler()

export default {
  fetch: (request: Request, env: Env): Promise<Response> => handler(request, env),
}
