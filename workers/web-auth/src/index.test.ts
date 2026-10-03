import { describe, it, expect } from 'vitest'
import { createHandler, type Env, type FetchImpl } from './index'
import { importCookieKey, open, seal, toBase64Url, fromBase64Url } from './session'

const ORIGIN = 'https://web.memlore.app'
const CLIENT_SECRET = 'GOCSPX-super-secret-value'
const REFRESH_TOKEN = '1//refresh-token-value'
const ACCESS_TOKEN = 'ya29.access-token-value'
const COOKIE_KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 1)))
const OTHER_KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => 200 - i)))
const RT_MAX_AGE = 180 * 24 * 60 * 60

const env: Env = {
  APP_ORIGIN: ORIGIN,
  GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
  COOKIE_KEY,
}

interface Call {
  url: string
  params: URLSearchParams
}

/** A Google stand-in that records every call and answers with the queued responses. */
function fakeGoogle(...responses: Response[]) {
  const calls: Call[] = []
  const fetchImpl: FetchImpl = async (input, init) => {
    calls.push({ url: input, params: new URLSearchParams(String(init?.body ?? '')) })
    const next = responses.shift()
    if (!next) throw new Error('unexpected Google call')
    return next
  }
  return { calls, fetchImpl }
}

const googleJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

async function sealed(purpose: 'pkce' | 'rt', data: unknown, key = COOKIE_KEY, ttl = 600) {
  const k = await importCookieKey(key)
  if (!k) throw new Error('bad key')
  return seal(k, purpose, data, ttl)
}

const setCookies = (res: Response): string[] => res.headers.getSetCookie()

function cookieValue(setCookie: string): string {
  return setCookie.split(';')[0].split('=').slice(1).join('=')
}

function post(path: string, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}${path}`, { method: 'POST', headers })
}

const trusted = (cookie?: string): Record<string, string> => ({
  Origin: ORIGIN,
  'X-Memlore': '1',
  ...(cookie ? { Cookie: cookie } : {}),
})

async function runStart() {
  const res = await createHandler()(new Request(`${ORIGIN}/api/oauth/start`), env)
  const loc = new URL(res.headers.get('Location') ?? '')
  const pkceCookie = setCookies(res)[0]
  return { res, loc, pkceCookie }
}

function expectNoSecrets(text: string) {
  for (const s of [CLIENT_SECRET, COOKIE_KEY, REFRESH_TOKEN, ACCESS_TOKEN]) {
    expect(text).not.toContain(s)
  }
}

describe('session cookie sealing', () => {
  it('round-trips data', async () => {
    const key = (await importCookieKey(COOKIE_KEY))!
    const token = await seal(key, 'rt', { rt: 'abc' }, 60)
    expect(await open(key, 'rt', token)).toEqual({ rt: 'abc' })
  })

  it('does not leak the plaintext into the token', async () => {
    const token = await sealed('rt', { rt: REFRESH_TOKEN })
    expect(token).not.toContain('refresh')
    expect(atob(token.replace(/-/g, '+').replace(/_/g, '/'))).not.toContain('refresh')
  })

  it('rejects a flipped ciphertext byte', async () => {
    const key = (await importCookieKey(COOKIE_KEY))!
    const token = await sealed('rt', { rt: 'abc' })
    const bytes = fromBase64Url(token)!
    bytes[bytes.length - 20] ^= 0x01
    expect(await open(key, 'rt', toBase64Url(bytes))).toBeNull()
  })

  it('rejects a flipped IV byte and a flipped tag byte', async () => {
    const key = (await importCookieKey(COOKIE_KEY))!
    const token = await sealed('rt', { rt: 'abc' })
    const iv = fromBase64Url(token)!
    iv[0] ^= 0x80
    expect(await open(key, 'rt', toBase64Url(iv))).toBeNull()
    const tag = fromBase64Url(token)!
    tag[tag.length - 1] ^= 0x01
    expect(await open(key, 'rt', toBase64Url(tag))).toBeNull()
  })

  it('rejects truncated, empty and garbage tokens', async () => {
    const key = (await importCookieKey(COOKIE_KEY))!
    const token = await sealed('rt', { rt: 'abc' })
    expect(await open(key, 'rt', token.slice(0, token.length - 4))).toBeNull()
    expect(await open(key, 'rt', '')).toBeNull()
    expect(await open(key, 'rt', 'AAAA')).toBeNull()
    expect(await open(key, 'rt', 'not base64 !!!')).toBeNull()
    expect(await open(key, 'rt', 'a'.repeat(200))).toBeNull()
  })

  it('rejects a token sealed under another key', async () => {
    const key = (await importCookieKey(COOKIE_KEY))!
    expect(await open(key, 'rt', await sealed('rt', { rt: 'abc' }, OTHER_KEY))).toBeNull()
  })

  it('rejects a cookie of the other purpose in both directions', async () => {
    const key = (await importCookieKey(COOKIE_KEY))!
    expect(await open(key, 'rt', await sealed('pkce', { state: 's', verifier: 'v' }))).toBeNull()
    expect(await open(key, 'pkce', await sealed('rt', { rt: 'abc' }))).toBeNull()
  })

  it('rejects an expired cookie', async () => {
    const key = (await importCookieKey(COOKIE_KEY))!
    const token = await seal(key, 'rt', { rt: 'abc' }, 60, 1_000_000)
    expect(await open(key, 'rt', token, 1_000_000 + 59_000)).toEqual({ rt: 'abc' })
    expect(await open(key, 'rt', token, 1_000_000 + 60_000)).toBeNull()
  })

  it('refuses a missing or wrong-length key', async () => {
    expect(await importCookieKey(undefined)).toBeNull()
    expect(await importCookieKey('')).toBeNull()
    expect(await importCookieKey('!!!')).toBeNull()
    expect(await importCookieKey(btoa('short'))).toBeNull()
  })
})

describe('GET /api/oauth/start', () => {
  it('redirects to Google with PKCE, offline access and the appdata scope only', async () => {
    const { res, loc } = await runStart()
    expect(res.status).toBe(302)
    expect(`${loc.origin}${loc.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    const q = loc.searchParams
    expect(q.get('client_id')).toBe(env.GOOGLE_CLIENT_ID)
    expect(q.get('redirect_uri')).toBe(`${ORIGIN}/api/oauth/callback`)
    expect(q.get('response_type')).toBe('code')
    expect(q.get('scope')).toBe('https://www.googleapis.com/auth/drive.appdata')
    expect(q.get('access_type')).toBe('offline')
    expect(q.get('prompt')).toBe('consent')
    expect(q.get('include_granted_scopes')).toBe('false')
    expect(q.get('code_challenge_method')).toBe('S256')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expectNoSecrets(loc.toString())
  })

  it('sets a Lax PKCE cookie whose verifier matches the S256 challenge', async () => {
    const { loc, pkceCookie } = await runStart()
    expect(pkceCookie).toMatch(/^ml_pkce=[A-Za-z0-9_-]+; /)
    expect(pkceCookie.split('; ').slice(1)).toEqual([
      'Max-Age=600',
      'Path=/api/oauth',
      'HttpOnly',
      'Secure',
      'SameSite=Lax',
    ])
    const key = (await importCookieKey(COOKIE_KEY))!
    const data = (await open(key, 'pkce', cookieValue(pkceCookie))) as {
      state: string
      verifier: string
    }
    expect(data.state).toBe(loc.searchParams.get('state'))
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data.verifier))
    expect(loc.searchParams.get('code_challenge')).toBe(toBase64Url(new Uint8Array(digest)))
    expect(data.verifier.length).toBeGreaterThanOrEqual(43)
  })

  it('uses a fresh state and verifier on every call', async () => {
    const a = await runStart()
    const b = await runStart()
    expect(a.loc.searchParams.get('state')).not.toBe(b.loc.searchParams.get('state'))
    expect(a.loc.searchParams.get('code_challenge')).not.toBe(
      b.loc.searchParams.get('code_challenge'),
    )
  })

  it('returns a generic 500 when the cookie key is not configured', async () => {
    const res = await createHandler()(new Request(`${ORIGIN}/api/oauth/start`), {
      ...env,
      COOKIE_KEY: '',
    })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'server' })
  })

  it('returns a generic 500 when the Google client id is not configured', async () => {
    const res = await createHandler()(new Request(`${ORIGIN}/api/oauth/start`), {
      ...env,
      GOOGLE_CLIENT_ID: '',
    })
    expect(res.status).toBe(500)
    expect(res.headers.get('Location')).toBeNull()
    expect(await res.json()).toEqual({ error: 'server' })
  })
})

describe('GET /api/oauth/callback', () => {
  it('serves the completion page with nosniff, no-referrer and frame-ancestors none', async () => {
    const res = await createHandler()(new Request(`${ORIGIN}/api/oauth/callback`), env)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'")
  })

  async function callback(opts: {
    query?: string
    cookie?: string | null
    google?: Response[]
    cookieData?: unknown
  }) {
    const state = 'state-abc'
    const cookie =
      opts.cookie === null
        ? undefined
        : (opts.cookie ??
          `ml_pkce=${await sealed('pkce', opts.cookieData ?? { state, verifier: 'verifier-xyz' })}`)
    const google = fakeGoogle(...(opts.google ?? []))
    const res = await createHandler(google.fetchImpl)(
      new Request(`${ORIGIN}/api/oauth/callback?${opts.query ?? `code=auth-code&state=${state}`}`, {
        headers: cookie ? { Cookie: cookie } : {},
      }),
      env,
    )
    return { res, google, body: await res.text() }
  }

  const tokens = () => googleJson({ access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN })

  it('exchanges the code, sets ml_rt (Strict) and serves the completion page', async () => {
    const { res, google, body } = await callback({ google: [tokens()] })
    expect(res.status).toBe(200)
    expect(google.calls).toHaveLength(1)
    expect(google.calls[0].url).toBe('https://oauth2.googleapis.com/token')
    const p = google.calls[0].params
    expect(p.get('grant_type')).toBe('authorization_code')
    expect(p.get('code')).toBe('auth-code')
    expect(p.get('code_verifier')).toBe('verifier-xyz')
    expect(p.get('client_secret')).toBe(CLIENT_SECRET)
    expect(p.get('client_id')).toBe(env.GOOGLE_CLIENT_ID)
    expect(p.get('redirect_uri')).toBe(`${ORIGIN}/api/oauth/callback`)

    const cookies = setCookies(res)
    expect(cookies).toHaveLength(2)
    expect(cookies[0]).toBe('ml_pkce=; Max-Age=0; Path=/api/oauth; HttpOnly; Secure; SameSite=Lax')
    expect(cookies[1].split('; ').slice(1)).toEqual([
      `Max-Age=${RT_MAX_AGE}`,
      'Path=/api/oauth',
      'HttpOnly',
      'Secure',
      'SameSite=Strict',
    ])
    const key = (await importCookieKey(COOKIE_KEY))!
    expect(await open(key, 'rt', cookieValue(cookies[1]))).toEqual({ rt: REFRESH_TOKEN })

    expect(res.headers.get('Content-Type')).toContain('text/html')
    expect(res.headers.get('Content-Security-Policy')).toBe(
      "default-src 'none'; script-src 'self'; frame-ancestors 'none'",
    )
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(body).toContain('src="/api/oauth/done.js"')
    expect(body).toContain('data-result="done"')
    expect(body).not.toMatch(/<script>/)
    expectNoSecrets(body)
    expectNoSecrets(JSON.stringify([...res.headers]).replace(cookies[1], ''))
  })

  it('rejects a state mismatch without calling Google', async () => {
    const { res, google, body } = await callback({
      query: 'code=c&state=other',
      google: [tokens()],
    })
    expect(res.status).toBe(400)
    expect(google.calls).toHaveLength(0)
    expect(body).toContain('data-result="error"')
    expect(setCookies(res).some((c) => c.startsWith('ml_rt='))).toBe(false)
    expect(setCookies(res)[0]).toContain('ml_pkce=; Max-Age=0')
  })

  it('rejects a missing state, a missing code and a missing PKCE cookie', async () => {
    for (const opts of [{ query: 'code=c' }, { query: 'state=state-abc' }, { cookie: null }]) {
      const { res, google } = await callback({ ...opts, google: [tokens()] })
      expect(res.status).toBe(400)
      expect(google.calls).toHaveLength(0)
    }
  })

  it('rejects a replay after the cookie was cleared', async () => {
    const { res, google } = await callback({ cookie: 'ml_pkce=', google: [tokens()] })
    expect(res.status).toBe(400)
    expect(google.calls).toHaveLength(0)
  })

  it('rejects a tampered, wrong-purpose or malformed PKCE cookie', async () => {
    const good = await sealed('pkce', { state: 'state-abc', verifier: 'v' })
    const flipped = fromBase64Url(good)!
    flipped[20] ^= 0x01
    const wrongPurpose = await sealed('rt', { state: 'state-abc', verifier: 'v' })
    const wrongShape = await sealed('pkce', { state: 'state-abc' })
    for (const value of [toBase64Url(flipped), wrongPurpose, wrongShape, 'garbage']) {
      const { res, google } = await callback({ cookie: `ml_pkce=${value}`, google: [tokens()] })
      expect(res.status).toBe(400)
      expect(google.calls).toHaveLength(0)
    }
  })

  it('returns the generic error page when Google fails, with no detail', async () => {
    const detail = 'secret-google-detail'
    for (const google of [
      [googleJson({ error: 'invalid_grant', error_description: detail }, 400)],
      [googleJson({ access_token: ACCESS_TOKEN })],
      [googleJson({ refresh_token: '' })],
    ]) {
      const { res, body } = await callback({ google })
      expect(res.status).toBe(400)
      expect(body).toContain('data-result="error"')
      expect(body).not.toContain(detail)
      expectNoSecrets(body)
      expect(setCookies(res).some((c) => c.startsWith('ml_rt='))).toBe(false)
    }
  })

  it('returns the generic error page when the Google call throws', async () => {
    const res = await createHandler(async () => {
      throw new Error('network down')
    })(
      new Request(`${ORIGIN}/api/oauth/callback?code=c&state=state-abc`, {
        headers: {
          Cookie: `ml_pkce=${await sealed('pkce', { state: 'state-abc', verifier: 'v' })}`,
        },
      }),
      env,
    )
    expect(res.status).toBe(400)
    expect(await res.text()).not.toContain('network down')
  })
})

describe('GET /api/oauth/done.js', () => {
  it('serves a static script under the same CSP', async () => {
    const res = await createHandler()(new Request(`${ORIGIN}/api/oauth/done.js`), env)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/javascript')
    expect(res.headers.get('Content-Security-Policy')).toBe(
      "default-src 'none'; script-src 'self'; frame-ancestors 'none'",
    )
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer')
    const body = await res.text()
    expect(body).toContain('BroadcastChannel')
    expectNoSecrets(body)
  })
})

describe('POST /api/oauth/token', () => {
  const rtCookie = async (data: unknown = { rt: REFRESH_TOKEN }) =>
    `ml_rt=${await sealed('rt', data, COOKIE_KEY, RT_MAX_AGE)}`

  it('returns a fresh access token with no-store', async () => {
    const google = fakeGoogle(
      googleJson({ access_token: ACCESS_TOKEN, expires_in: 3599, scope: 'x', id_token: 'leak' }),
    )
    const res = await createHandler(google.fetchImpl)(
      post('/api/oauth/token', trusted(await rtCookie())),
      env,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(await res.json()).toEqual({ access_token: ACCESS_TOKEN, expires_in: 3599 })
    expect(google.calls[0].url).toBe('https://oauth2.googleapis.com/token')
    const p = google.calls[0].params
    expect(p.get('grant_type')).toBe('refresh_token')
    expect(p.get('refresh_token')).toBe(REFRESH_TOKEN)
    expect(p.get('client_secret')).toBe(CLIENT_SECRET)
  })

  it('clears the cookie and answers reauth on invalid_grant, with no Google detail', async () => {
    const google = fakeGoogle(
      googleJson({ error: 'invalid_grant', error_description: 'Token has been revoked' }, 400),
    )
    const res = await createHandler(google.fetchImpl)(
      post('/api/oauth/token', trusted(await rtCookie())),
      env,
    )
    expect(res.status).toBe(401)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ error: 'reauth' })
    expect(text).not.toContain('revoked')
    expect(setCookies(res)).toEqual([
      'ml_rt=; Max-Age=0; Path=/api/oauth; HttpOnly; Secure; SameSite=Strict',
    ])
  })

  it('answers reauth without calling Google when the cookie is absent, tampered or wrong purpose', async () => {
    const wrong = `ml_rt=${await sealed('pkce', { rt: REFRESH_TOKEN })}`
    for (const cookie of [undefined, 'ml_rt=garbage', wrong, await rtCookie({ nope: 1 })]) {
      const google = fakeGoogle()
      const res = await createHandler(google.fetchImpl)(
        post('/api/oauth/token', trusted(cookie)),
        env,
      )
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'reauth' })
      expect(google.calls).toHaveLength(0)
    }
  })

  it('answers a generic 502 on other upstream failures and keeps the cookie', async () => {
    for (const g of [
      googleJson({ error: 'server_error', error_description: 'boom' }, 500),
      googleJson({ access_token: ACCESS_TOKEN }),
    ]) {
      const res = await createHandler(fakeGoogle(g).fetchImpl)(
        post('/api/oauth/token', trusted(await rtCookie())),
        env,
      )
      expect(res.status).toBe(502)
      expect(await res.json()).toEqual({ error: 'upstream' })
      expect(setCookies(res)).toHaveLength(0)
    }
    const thrown = await createHandler(async () => {
      throw new Error('network down')
    })(post('/api/oauth/token', trusted(await rtCookie())), env)
    expect(thrown.status).toBe(502)
  })
})

describe.each(['/api/oauth/token', '/api/oauth/logout'])('POST %s origin guard', (path) => {
  const bad: [string, Record<string, string>][] = [
    ['no Origin', { 'X-Memlore': '1' }],
    ['Origin null', { Origin: 'null', 'X-Memlore': '1' }],
    ['foreign Origin', { Origin: 'https://evil.example', 'X-Memlore': '1' }],
    ['suffix trick', { Origin: 'https://web.memlore.app.evil.com', 'X-Memlore': '1' }],
    ['prefix trick', { Origin: 'https://evil.web.memlore.app', 'X-Memlore': '1' }],
    ['http scheme', { Origin: 'http://web.memlore.app', 'X-Memlore': '1' }],
    ['trailing slash', { Origin: `${ORIGIN}/`, 'X-Memlore': '1' }],
    ['missing X-Memlore', { Origin: ORIGIN }],
    ['wrong X-Memlore', { Origin: ORIGIN, 'X-Memlore': '0' }],
  ]

  it.each(bad)('rejects %s without touching Google or clearing cookies', async (_name, headers) => {
    const google = fakeGoogle()
    const cookie = `ml_rt=${await sealed('rt', { rt: REFRESH_TOKEN })}`
    const res = await createHandler(google.fetchImpl)(
      post(path, { ...headers, Cookie: cookie }),
      env,
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'forbidden' })
    expect(google.calls).toHaveLength(0)
    expect(setCookies(res)).toHaveLength(0)
  })
})

describe('POST /api/oauth/logout', () => {
  it('revokes the refresh token at Google and clears the cookie', async () => {
    const google = fakeGoogle(new Response(null, { status: 200 }))
    const cookie = `ml_rt=${await sealed('rt', { rt: REFRESH_TOKEN })}`
    const res = await createHandler(google.fetchImpl)(
      post('/api/oauth/logout', trusted(cookie)),
      env,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(google.calls).toHaveLength(1)
    expect(google.calls[0].url).toBe('https://oauth2.googleapis.com/revoke')
    expect(google.calls[0].params.get('token')).toBe(REFRESH_TOKEN)
    expect(setCookies(res)).toEqual([
      'ml_rt=; Max-Age=0; Path=/api/oauth; HttpOnly; Secure; SameSite=Strict',
    ])
  })

  it('still clears the cookie when revocation fails or there is no cookie', async () => {
    const cookie = `ml_rt=${await sealed('rt', { rt: REFRESH_TOKEN })}`
    const failing = await createHandler(async () => {
      throw new Error('network down')
    })(post('/api/oauth/logout', trusted(cookie)), env)
    expect(failing.status).toBe(200)
    expect(setCookies(failing)[0]).toContain('ml_rt=; Max-Age=0')

    const google = fakeGoogle()
    const bare = await createHandler(google.fetchImpl)(post('/api/oauth/logout', trusted()), env)
    expect(bare.status).toBe(200)
    expect(google.calls).toHaveLength(0)
    expect(setCookies(bare)[0]).toContain('ml_rt=; Max-Age=0')
  })
})

describe('GET /api/config', () => {
  async function writes(value: string | undefined) {
    const res = await createHandler()(new Request(`${ORIGIN}/api/config`), {
      ...env,
      WEB_WRITES_ENABLED: value,
    })
    expect(res.status).toBe(200)
    return ((await res.json()) as { writes: boolean }).writes
  }

  it('fails closed unless the var is exactly "1"', async () => {
    expect(await writes(undefined)).toBe(false)
    for (const v of ['', '0', 'true', '1 ', ' 1', 'yes', '11']) expect(await writes(v)).toBe(false)
    expect(await writes('1')).toBe(true)
  })
})

describe('routing and information hygiene', () => {
  const handler = createHandler(fakeGoogle().fetchImpl)

  it('answers 404 for unknown paths, generically', async () => {
    for (const path of [
      '/',
      '/api',
      '/api/oauth',
      '/api/oauth/start/',
      '/api/oauth/TOKEN',
      '/admin',
    ]) {
      const res = await handler(new Request(`${ORIGIN}${path}`), env)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'not_found' })
    }
  })

  it('answers 405 for the wrong method, generically', async () => {
    const cases: [string, string][] = [
      ['POST', '/api/oauth/start'],
      ['POST', '/api/oauth/callback'],
      ['POST', '/api/config'],
      ['GET', '/api/oauth/token'],
      ['GET', '/api/oauth/logout'],
      ['PUT', '/api/oauth/token'],
      ['DELETE', '/api/oauth/logout'],
    ]
    for (const [method, path] of cases) {
      const res = await handler(new Request(`${ORIGIN}${path}`, { method }), env)
      expect(res.status).toBe(405)
      expect(await res.json()).toEqual({ error: 'method_not_allowed' })
    }
  })

  it('never echoes request headers or the request URL query, and never leaks secrets', async () => {
    const marker = 'echo-marker-4242'
    const requests = [
      new Request(`${ORIGIN}/nope?q=${marker}`, { headers: { 'X-Probe': marker } }),
      new Request(`${ORIGIN}/api/config?q=${marker}`, { headers: { 'X-Probe': marker } }),
      new Request(`${ORIGIN}/api/oauth/token`, { method: 'GET', headers: { 'X-Probe': marker } }),
      post('/api/oauth/token', { Origin: marker, 'X-Probe': marker }),
      post('/api/oauth/logout', { Origin: marker, 'X-Probe': marker }),
      new Request(`${ORIGIN}/api/oauth/callback?code=${marker}&state=${marker}`, {
        headers: { 'X-Probe': marker, Cookie: `ml_pkce=${marker}` },
      }),
    ]
    for (const request of requests) {
      const res = await handler(request, env)
      const dump = `${await res.text()}\n${JSON.stringify([...res.headers])}`
      expect(dump).not.toContain(marker)
      expectNoSecrets(dump)
    }
  })
})
