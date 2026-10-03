/**
 * Browser OAuth client for the web-auth Worker (workers/web-auth).
 *
 * The refresh token lives in an HttpOnly cookie the page can never read. The short-lived access
 * token lives in module RAM only: never localStorage, sessionStorage, IndexedDB or JS-set cookies.
 * connect() mirrors the desktop gdrive_begin_connect / gdrive_complete_connect await model: it
 * opens a popup (App state is kept) and resolves once the popup reports completion.
 */

const START_URL = '/api/oauth/start'
const TOKEN_URL = '/api/oauth/token'
const LOGOUT_URL = '/api/oauth/logout'
const CONFIG_URL = '/api/config'
const CHANNEL_NAME = 'memlore-oauth'
const POPUP_NAME = 'memlore-oauth'
const POPUP_FEATURES = 'popup,width=500,height=700'
const DONE_TYPE = 'memlore-oauth-done'
const ERROR_TYPE = 'memlore-oauth-error'

/** Refresh when the cached token is within this window of expiring. */
export const REFRESH_MARGIN_MS = 60_000
const POPUP_POLL_MS = 500
const CONNECT_TIMEOUT_MS = 5 * 60_000

/** The refresh cookie is missing or revoked: the user must connect again. */
export class ReauthRequiredError extends Error {
  constructor() {
    super('Google Drive session expired; reconnect required')
    this.name = 'ReauthRequiredError'
  }
}

/** The token endpoint could not be reached or answered unusably. Any cached token is kept. */
export class OAuthNetworkError extends Error {
  constructor(message = 'Could not reach the sign-in service') {
    super(message)
    this.name = 'OAuthNetworkError'
  }
}

/** The popup flow failed, was blocked, was cancelled or timed out. */
export class OAuthConnectError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OAuthConnectError'
  }
}

export interface PopupHandle {
  readonly closed: boolean
  close?: () => void
}

export interface ChannelHandle {
  onmessage: ((event: { data: unknown }) => void) | null
  close: () => void
}

export interface OAuthClientDeps {
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>
  now: () => number
  openPopup: (url: string, name: string, features: string) => PopupHandle | null
  createChannel: (name: string) => ChannelHandle
  setIntervalImpl: (fn: () => void, ms: number) => unknown
  clearIntervalImpl: (id: unknown) => void
  setTimeoutImpl: (fn: () => void, ms: number) => unknown
  clearTimeoutImpl: (id: unknown) => void
}

export interface OAuthClient {
  connect: () => Promise<void>
  getAccessToken: () => Promise<string>
  logout: () => Promise<void>
  isConnected: () => boolean
  fetchWritesEnabled: () => Promise<boolean>
}

function defaultDeps(): OAuthClientDeps {
  return {
    fetchImpl: (input, init) => globalThis.fetch(input, init),
    now: () => Date.now(),
    openPopup: (url, name, features) => globalThis.open(url, name, features),
    createChannel: (name) => {
      const bc = new BroadcastChannel(name)
      const handle: ChannelHandle = {
        onmessage: null,
        close: () => bc.close(),
      }
      bc.onmessage = (event) => handle.onmessage?.({ data: event.data as unknown })
      return handle
    },
    setIntervalImpl: (fn, ms) => globalThis.setInterval(fn, ms),
    clearIntervalImpl: (id) => globalThis.clearInterval(id as number),
    setTimeoutImpl: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeoutImpl: (id) => globalThis.clearTimeout(id as number),
  }
}

const POST_HEADERS = { 'X-Memlore': '1' }

function messageType(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const type = (data as { type?: unknown }).type
  return type === DONE_TYPE || type === ERROR_TYPE ? type : null
}

export function createOAuthClient(overrides: Partial<OAuthClientDeps> = {}): OAuthClient {
  const deps: OAuthClientDeps = { ...defaultDeps(), ...overrides }
  let token: { value: string; expiresAt: number } | null = null
  let inFlight: { gen: number; promise: Promise<string> } | null = null
  // Bumped by logout/reauth/connect so a stale in-flight refresh cannot resurrect a cleared token.
  let generation = 0

  // A bump also drops the in-flight request: it was made with the old (or absent) cookie, so a
  // refresh started after the bump must not coalesce onto it.
  const bumpGeneration = (): void => {
    generation++
    inFlight = null
  }

  const isFresh = (): boolean => token !== null && token.expiresAt - deps.now() > REFRESH_MARGIN_MS

  async function requestToken(): Promise<string> {
    const gen = generation
    let res: Response
    try {
      res = await deps.fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: POST_HEADERS,
        credentials: 'same-origin',
        cache: 'no-store',
      })
    } catch {
      throw new OAuthNetworkError()
    }
    if (res.status === 401) {
      // A newer generation (login/logout) owns the token now; a stale 401 must not clear it.
      if (gen === generation) {
        bumpGeneration()
        token = null
      }
      throw new ReauthRequiredError()
    }
    if (!res.ok) throw new OAuthNetworkError(`Token endpoint returned ${res.status}`)
    let body: { access_token?: unknown; expires_in?: unknown }
    try {
      body = (await res.json()) as typeof body
    } catch {
      throw new OAuthNetworkError('Token endpoint returned invalid JSON')
    }
    if (typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') {
      throw new OAuthNetworkError('Token endpoint returned an unexpected body')
    }
    if (gen === generation) {
      token = { value: body.access_token, expiresAt: deps.now() + body.expires_in * 1000 }
    }
    return body.access_token
  }

  function refresh(): Promise<string> {
    if (inFlight && inFlight.gen === generation) return inFlight.promise
    const entry: { gen: number; promise: Promise<string> } = {
      gen: generation,
      promise: Promise.resolve(''),
    }
    entry.promise = requestToken().finally(() => {
      if (inFlight === entry) inFlight = null
    })
    inFlight = entry
    return entry.promise
  }

  async function getAccessToken(): Promise<string> {
    if (token && isFresh()) return token.value
    return refresh()
  }

  function connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // The popup is a fresh login: drop any cached token so the next read uses the new cookie.
      bumpGeneration()
      token = null
      let settled = false
      let poll: unknown = null
      let timer: unknown = null
      let channel: ChannelHandle | null = null
      let popup: PopupHandle | null = null

      const finish = (error: Error | null): void => {
        if (settled) return
        settled = true
        if (poll !== null) deps.clearIntervalImpl(poll)
        if (timer !== null) deps.clearTimeoutImpl(timer)
        if (channel) {
          channel.onmessage = null
          channel.close()
        }
        if (error) reject(error)
        else resolve()
      }

      try {
        // Subscribe before opening so the popup's message cannot be missed.
        channel = deps.createChannel(CHANNEL_NAME)
        channel.onmessage = (event) => {
          const type = messageType(event.data)
          // The channel is same-origin but not authenticated: never trust "done" on its own, only a
          // session the token endpoint actually grants. A forged "error" can merely abort a connect.
          if (type === DONE_TYPE) {
            refresh().then(
              () => finish(null),
              () => finish(new OAuthConnectError('Sign-in did not complete')),
            )
          } else if (type === ERROR_TYPE) finish(new OAuthConnectError('Sign-in failed'))
        }
        popup = deps.openPopup(START_URL, POPUP_NAME, POPUP_FEATURES)
      } catch {
        finish(new OAuthConnectError('Could not start sign-in'))
        return
      }
      if (!popup) {
        finish(new OAuthConnectError('Sign-in popup was blocked'))
        return
      }

      const handle = popup
      poll = deps.setIntervalImpl(() => {
        if (settled || !handle.closed) return
        // Popup closed without a message (or the message is still in flight): check for a session once.
        deps.clearIntervalImpl(poll)
        poll = null
        refresh().then(
          () => finish(null),
          () => finish(new OAuthConnectError('Sign-in cancelled')),
        )
      }, POPUP_POLL_MS)
      timer = deps.setTimeoutImpl(() => {
        handle.close?.()
        finish(new OAuthConnectError('Sign-in timed out'))
      }, CONNECT_TIMEOUT_MS)
    })
  }

  async function logout(): Promise<void> {
    bumpGeneration()
    token = null
    try {
      await deps.fetchImpl(LOGOUT_URL, {
        method: 'POST',
        headers: POST_HEADERS,
        credentials: 'same-origin',
      })
    } catch {
      // The RAM token is already cleared; the cookie expires on its own if the call never lands.
    }
  }

  async function fetchWritesEnabled(): Promise<boolean> {
    try {
      const res = await deps.fetchImpl(CONFIG_URL, { cache: 'no-store' })
      if (!res.ok) return false
      const body = (await res.json()) as { writes?: unknown } | null
      return body?.writes === true
    } catch {
      return false
    }
  }

  return { connect, getAccessToken, logout, isConnected: () => token !== null, fetchWritesEnabled }
}

/** App-wide client using the real fetch, window.open and BroadcastChannel. */
export const oauth: OAuthClient = createOAuthClient()
