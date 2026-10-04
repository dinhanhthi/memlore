import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OAuthConnectError,
  OAuthNetworkError,
  ReauthRequiredError,
  createOAuthClient,
  type ChannelHandle,
  type OAuthClientDeps,
  type PopupHandle,
  isSignInCancelled,
} from './oauth'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const tokenResponse = (token = 'tok', expiresIn = 3600): Response =>
  jsonResponse({ access_token: token, expires_in: expiresIn })

interface Harness {
  client: ReturnType<typeof createOAuthClient>
  fetchImpl: ReturnType<typeof vi.fn>
  clock: { t: number }
  popup: { closed: boolean; close: ReturnType<typeof vi.fn>; location: { href: string } }
  channel: ChannelHandle & { emit: (data: unknown) => void }
  openPopup: ReturnType<typeof vi.fn>
  tick: () => void
  fireTimeout: () => void
}

function makeHarness(fetchImpl: ReturnType<typeof vi.fn> = vi.fn()): Harness {
  const clock = { t: 1_000_000 }
  const popup = { closed: false, close: vi.fn(), location: { href: '' } }
  const channel = {
    onmessage: null as ChannelHandle['onmessage'],
    close: vi.fn(),
    emit(data: unknown) {
      channel.onmessage?.({ data })
    },
  }
  const openPopup = vi.fn((): PopupHandle | null => popup)
  let intervalFn: (() => void) | null = null
  let timeoutFn: (() => void) | null = null
  const deps: Partial<OAuthClientDeps> = {
    fetchImpl: fetchImpl as unknown as OAuthClientDeps['fetchImpl'],
    now: () => clock.t,
    openPopup,
    createChannel: () => channel,
    setIntervalImpl: (fn) => {
      intervalFn = fn
      return 1
    },
    clearIntervalImpl: () => {
      intervalFn = null
    },
    setTimeoutImpl: (fn) => {
      timeoutFn = fn
      return 2
    },
    clearTimeoutImpl: () => {
      timeoutFn = null
    },
  }
  return {
    client: createOAuthClient(deps),
    fetchImpl,
    clock,
    popup,
    channel,
    openPopup,
    tick: () => intervalFn?.(),
    fireTimeout: () => timeoutFn?.(),
  }
}

describe('storage is never touched', () => {
  const trap = {
    get() {
      throw new Error('storage touched')
    },
  }
  beforeEach(() => {
    vi.stubGlobal('localStorage', new Proxy({}, trap))
    vi.stubGlobal('sessionStorage', new Proxy({}, trap))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('token lifecycle and logout persist nothing', async () => {
    const h = makeHarness(vi.fn(async () => tokenResponse()))
    await h.client.getAccessToken()
    await h.client.logout()
    expect(h.client.isConnected()).toBe(false)
  })
})

describe('getAccessToken', () => {
  it('reuses the token until 60 s before expiry, then refreshes', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse('a', 3600))
      .mockResolvedValueOnce(tokenResponse('b', 3600))
    const h = makeHarness(fetchImpl)
    expect(await h.client.getAccessToken()).toBe('a')
    h.clock.t += 3600_000 - 60_001
    expect(await h.client.getAccessToken()).toBe('a')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    h.clock.t += 1
    expect(await h.client.getAccessToken()).toBe('b')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('refreshes an expired token', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse('a', 100))
      .mockResolvedValueOnce(tokenResponse('b', 100))
    const h = makeHarness(fetchImpl)
    await h.client.getAccessToken()
    h.clock.t += 200_000
    expect(await h.client.getAccessToken()).toBe('b')
  })

  it('coalesces concurrent refreshes into one request', async () => {
    const fetchImpl = vi.fn(async () => tokenResponse('a'))
    const h = makeHarness(fetchImpl)
    const results = await Promise.all([
      h.client.getAccessToken(),
      h.client.getAccessToken(),
      h.client.getAccessToken(),
    ])
    expect(results).toEqual(['a', 'a', 'a'])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('sends X-Memlore and same-origin credentials', async () => {
    const fetchImpl = vi.fn(async () => tokenResponse())
    const h = makeHarness(fetchImpl)
    await h.client.getAccessToken()
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/oauth/token')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'X-Memlore': '1' })
    expect(init.credentials).toBe('same-origin')
  })

  it('401 reauth clears state and throws ReauthRequiredError', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse('a', 100))
      .mockResolvedValueOnce(jsonResponse({ error: 'reauth' }, 401))
    const h = makeHarness(fetchImpl)
    await h.client.getAccessToken()
    expect(h.client.isConnected()).toBe(true)
    h.clock.t += 100_000
    await expect(h.client.getAccessToken()).rejects.toBeInstanceOf(ReauthRequiredError)
    expect(h.client.isConnected()).toBe(false)
  })

  it('network failure throws OAuthNetworkError and keeps a still-valid token', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse('a', 3600))
      .mockRejectedValueOnce(new TypeError('offline'))
    const h = makeHarness(fetchImpl)
    await h.client.getAccessToken()
    h.clock.t += 3600_000 - 30_000 // inside the margin but not yet expired
    await expect(h.client.getAccessToken()).rejects.toBeInstanceOf(OAuthNetworkError)
    expect(h.client.isConnected()).toBe(true)
  })

  it('a 500 or malformed body is an OAuthNetworkError', async () => {
    const h1 = makeHarness(vi.fn(async () => jsonResponse({ error: 'x' }, 500)))
    await expect(h1.client.getAccessToken()).rejects.toBeInstanceOf(OAuthNetworkError)
    const h2 = makeHarness(vi.fn(async () => jsonResponse({ access_token: 1 })))
    await expect(h2.client.getAccessToken()).rejects.toBeInstanceOf(OAuthNetworkError)
  })
})

describe('logout', () => {
  it('posts with the guard header and clears the token', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url === '/api/oauth/token' ? tokenResponse() : jsonResponse({ ok: true }),
    )
    const h = makeHarness(fetchImpl)
    await h.client.getAccessToken()
    await h.client.logout()
    const [url, init] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit]
    expect(url).toBe('/api/oauth/logout')
    expect(init.headers).toEqual({ 'X-Memlore': '1' })
    expect(h.client.isConnected()).toBe(false)
  })

  it('clears the token even when the network call fails', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockRejectedValueOnce(new TypeError('offline'))
    const h = makeHarness(fetchImpl)
    await h.client.getAccessToken()
    await expect(h.client.logout()).resolves.toBeUndefined()
    expect(h.client.isConnected()).toBe(false)
  })

  it('an in-flight refresh started before logout does not resurrect the token', async () => {
    let release: (r: Response) => void = () => {}
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(() => new Promise<Response>((r) => (release = r)))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
    const h = makeHarness(fetchImpl)
    const pending = h.client.getAccessToken()
    await h.client.logout()
    release(tokenResponse())
    await pending
    expect(h.client.isConnected()).toBe(false)
  })
})

describe('connect', () => {
  it('opens the start URL in a named popup', async () => {
    const h = makeHarness(vi.fn(async () => tokenResponse()))
    const p = h.client.connect()
    expect(h.openPopup).toHaveBeenCalledWith(
      '/api/oauth/start',
      'memlore-oauth',
      'popup,width=500,height=700',
    )
    h.channel.emit({ type: 'memlore-oauth-done' })
    await p
  })

  it('resolves on the done message once the token endpoint grants a session', async () => {
    const fetchImpl = vi.fn(async () => tokenResponse())
    const h = makeHarness(fetchImpl)
    const p = h.client.connect()
    h.channel.emit({ type: 'memlore-oauth-done' })
    await expect(p).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(h.client.isConnected()).toBe(true)
    expect(h.channel.close).toHaveBeenCalled()
  })

  it('a forged done message without a session rejects instead of resolving', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'reauth' }, 401))
    const h = makeHarness(fetchImpl)
    const p = h.client.connect()
    h.channel.emit({ type: 'memlore-oauth-done' })
    await expect(p).rejects.toThrow(/did not complete/)
    expect(h.client.isConnected()).toBe(false)
  })

  it('a refresh started before the login does not swallow the post-login refresh', async () => {
    let releaseStale: (r: Response) => void = () => {}
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(() => new Promise<Response>((r) => (releaseStale = r)))
      .mockResolvedValueOnce(tokenResponse('fresh'))
    const h = makeHarness(fetchImpl)
    const stale = h.client.getAccessToken() // made with the old cookie, still in flight
    const p = h.client.connect()
    h.channel.emit({ type: 'memlore-oauth-done' })
    await expect(p).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledTimes(2) // not coalesced onto the stale request
    expect(await h.client.getAccessToken()).toBe('fresh')
    releaseStale(jsonResponse({ error: 'reauth' }, 401))
    await expect(stale).rejects.toBeInstanceOf(ReauthRequiredError)
    expect(h.client.isConnected()).toBe(true) // the stale 401 must not clear the new token
  })

  it('rejects on the error message', async () => {
    const h = makeHarness()
    const p = h.client.connect()
    h.channel.emit({ type: 'memlore-oauth-error' })
    await expect(p).rejects.toBeInstanceOf(OAuthConnectError)
  })

  it('ignores messages that are not exactly done/error objects', async () => {
    const fetchImpl = vi.fn(async () => tokenResponse())
    const h = makeHarness(fetchImpl)
    let settled = false
    const p = h.client.connect().then(
      () => (settled = true),
      () => (settled = true),
    )
    for (const junk of [
      { type: 'memlore-oauth-don' },
      { type: 'memlore-oauth-done ' },
      { type: 'MEMLORE-OAUTH-DONE' },
      { type: ['memlore-oauth-done'] },
      { kind: 'memlore-oauth-done' },
      'memlore-oauth-done',
      '{"type":"memlore-oauth-done"}',
      null,
      undefined,
      42,
      [],
    ]) {
      h.channel.emit(junk)
    }
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
    h.channel.emit({ type: 'memlore-oauth-done' })
    await p
    expect(settled).toBe(true)
  })

  it('rejects when the popup is blocked', async () => {
    const h = makeHarness()
    h.openPopup.mockReturnValueOnce(null)
    await expect(h.client.connect()).rejects.toBeInstanceOf(OAuthConnectError)
  })

  it('closed popup with a session: polls the token once and resolves', async () => {
    const fetchImpl = vi.fn(async () => tokenResponse())
    const h = makeHarness(fetchImpl)
    const p = h.client.connect()
    h.tick()
    expect(fetchImpl).not.toHaveBeenCalled() // still open
    h.popup.closed = true
    h.tick()
    await expect(p).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(h.client.isConnected()).toBe(true)
  })

  it('closed popup without a session: rejects as cancelled after one poll', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'reauth' }, 401))
    const h = makeHarness(fetchImpl)
    const p = h.client.connect()
    h.popup.closed = true
    h.tick()
    await expect(p).rejects.toThrow(/cancelled/)
    // auth.ts maps exactly this error to OAUTH_CANCELLED: the two must not drift apart.
    expect(isSignInCancelled(await p.catch((e: unknown) => e))).toBe(true)
    h.tick()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('abort closes the popup, stops listening and ignores a late done message', async () => {
    const fetchImpl = vi.fn(async () => tokenResponse())
    const h = makeHarness(fetchImpl)
    const controller = new AbortController()
    const p = h.client.connect(controller.signal)
    controller.abort()
    expect(isSignInCancelled(await p.catch((e: unknown) => e))).toBe(true)
    expect(h.popup.close).toHaveBeenCalled()
    expect(h.channel.close).toHaveBeenCalled()
    h.channel.emit({ type: 'memlore-oauth-done' })
    h.popup.closed = true
    h.tick()
    await Promise.resolve()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(h.client.isConnected()).toBe(false)
  })

  it('abort after done drops the token of the refresh already in flight', async () => {
    let release: (r: Response) => void = () => {}
    const fetchImpl = vi.fn(() => new Promise<Response>((r) => (release = r)))
    const h = makeHarness(fetchImpl)
    const controller = new AbortController()
    const p = h.client.connect(controller.signal)
    h.channel.emit({ type: 'memlore-oauth-done' })
    controller.abort()
    release(tokenResponse())
    expect(isSignInCancelled(await p.catch((e: unknown) => e))).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(h.client.isConnected()).toBe(false)
  })

  it('an already aborted signal never opens the popup', async () => {
    const h = makeHarness()
    const controller = new AbortController()
    controller.abort()
    expect(isSignInCancelled(await h.client.connect(controller.signal).catch((e) => e))).toBe(true)
    expect(h.openPopup).not.toHaveBeenCalled()
  })

  it('times out, closing the popup', async () => {
    const h = makeHarness()
    const p = h.client.connect()
    h.fireTimeout()
    await expect(p).rejects.toThrow(/timed out/)
    expect(h.popup.close).toHaveBeenCalled()
  })
})

describe('connect after a logout still in flight', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0))

  /** Logout POST held until released; the token endpoint grants a session. */
  function heldLogout(): { h: Harness; release: () => void } {
    let release: () => void = () => {}
    const fetchImpl = vi.fn((url: string) =>
      url === '/api/oauth/logout'
        ? new Promise<Response>((r) => (release = () => r(jsonResponse({ ok: true }))))
        : Promise.resolve(tokenResponse('fresh')),
    )
    return { h: makeHarness(fetchImpl), release: () => release() }
  }

  it('opens the popup synchronously and navigates only once the logout settled', async () => {
    const { h, release } = heldLogout()
    void h.client.logout()
    const p = h.client.connect()
    expect(h.openPopup).toHaveBeenCalledWith(
      'about:blank',
      'memlore-oauth',
      'popup,width=500,height=700',
    )
    await flush()
    expect(h.popup.location.href).toBe('')
    release()
    await flush()
    expect(h.popup.location.href).toBe('/api/oauth/start')
    h.channel.emit({ type: 'memlore-oauth-done' })
    await expect(p).resolves.toBeUndefined()
    expect(h.client.isConnected()).toBe(true)
  })

  it('a closed popup during the wait is only checked after the logout landed', async () => {
    const { h, release } = heldLogout()
    void h.client.logout()
    const p = h.client.connect()
    h.popup.closed = true
    h.tick()
    await flush()
    expect(h.fetchImpl).toHaveBeenCalledTimes(1) // the logout only: no refresh on the old cookie
    release()
    await flush()
    h.tick()
    await expect(p).resolves.toBeUndefined()
  })

  it('a done message during the wait is stale and ignored', async () => {
    const { h, release } = heldLogout()
    void h.client.logout()
    const p = h.client.connect()
    h.channel.emit({ type: 'memlore-oauth-done' })
    await flush()
    expect(h.fetchImpl).toHaveBeenCalledTimes(1) // the logout only
    release()
    await flush()
    h.channel.emit({ type: 'memlore-oauth-done' })
    await expect(p).resolves.toBeUndefined()
  })

  it('a hanging logout delays the sign-in only up to the cap', async () => {
    const { h } = heldLogout()
    void h.client.logout()
    const p = h.client.connect()
    await flush()
    h.fireTimeout() // the logout wait cap
    await flush()
    expect(h.popup.location.href).toBe('/api/oauth/start')
    h.channel.emit({ type: 'memlore-oauth-done' })
    await expect(p).resolves.toBeUndefined()
    expect(h.client.isConnected()).toBe(true)
  })

  it('a failed logout does not block the sign-in', async () => {
    const fetchImpl = vi.fn((url: string) =>
      url === '/api/oauth/logout'
        ? Promise.reject(new TypeError('offline'))
        : Promise.resolve(tokenResponse()),
    )
    const h = makeHarness(fetchImpl)
    void h.client.logout()
    const p = h.client.connect()
    await flush()
    expect(h.popup.location.href).toBe('/api/oauth/start')
    h.channel.emit({ type: 'memlore-oauth-done' })
    await expect(p).resolves.toBeUndefined()
  })

  it('abort during the wait closes the popup and never navigates it', async () => {
    const { h, release } = heldLogout()
    void h.client.logout()
    const controller = new AbortController()
    const p = h.client.connect(controller.signal)
    controller.abort()
    release()
    expect(isSignInCancelled(await p.catch((e: unknown) => e))).toBe(true)
    await flush()
    expect(h.popup.close).toHaveBeenCalled()
    expect(h.popup.location.href).toBe('')
  })

  it('a settled logout no longer delays the next connect', async () => {
    const { h, release } = heldLogout()
    const out = h.client.logout()
    release()
    await out
    const p = h.client.connect()
    expect(h.openPopup).toHaveBeenCalledWith(
      '/api/oauth/start',
      expect.any(String),
      expect.any(String),
    )
    h.channel.emit({ type: 'memlore-oauth-done' })
    await p
  })
})

describe('fetchWritesEnabled', () => {
  const run = (impl: () => Promise<Response>) =>
    makeHarness(vi.fn(impl)).client.fetchWritesEnabled()

  it('is true only for {writes:true}, requested with no-store', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ writes: true }))
    const h = makeHarness(fetchImpl)
    expect(await h.client.fetchWritesEnabled()).toBe(true)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/config')
    expect(init.cache).toBe('no-store')
  })

  it('fails closed on every other outcome', async () => {
    expect(await run(() => Promise.reject(new TypeError('offline')))).toBe(false)
    expect(await run(async () => jsonResponse({ writes: true }, 500))).toBe(false)
    expect(await run(async () => new Response('not json'))).toBe(false)
    expect(await run(async () => jsonResponse({ writes: '1' }))).toBe(false)
    expect(await run(async () => jsonResponse({ writes: 1 }))).toBe(false)
    expect(await run(async () => jsonResponse({ writes: false }))).toBe(false)
    expect(await run(async () => jsonResponse({}))).toBe(false)
    expect(await run(async () => jsonResponse(null))).toBe(false)
  })
})
