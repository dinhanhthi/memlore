import { describe, it, expect, afterEach, vi } from 'vitest'
import worker, { authorized, logDownload } from './index'
import { esc } from './stats'

/** `crypto.subtle.timingSafeEqual` is a Cloudflare extension Node does not have. */
function stubTimingSafeEqual() {
  vi.stubGlobal('crypto', {
    subtle: {
      timingSafeEqual: (a: ArrayBufferView, b: ArrayBufferView) => {
        const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
        const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
        if (x.byteLength !== y.byteLength) throw new TypeError('length mismatch')
        return x.every((byte, i) => byte === y[i])
      },
    },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

function ask(target: string, headers: Record<string, string> = {}) {
  const url = new URL(target)
  return { request: new Request(target, { headers }), url }
}

describe('authorized', () => {
  it('denies when STATS_KEY is not configured', () => {
    const { request, url } = ask('https://dl.memlore.app/stats?key=secret')
    expect(authorized(request, url, { DB: {} as D1Database })).toBe(false)
  })

  it('denies when no key is supplied at all', () => {
    const { request, url } = ask('https://dl.memlore.app/stats')
    expect(authorized(request, url, { DB: {} as D1Database, STATS_KEY: 'secret' })).toBe(false)
  })

  it('denies a key of a different length without calling timingSafeEqual', () => {
    // No crypto stub on purpose: the length branch must return before it.
    const { request, url } = ask('https://dl.memlore.app/stats?key=short')
    expect(authorized(request, url, { DB: {} as D1Database, STATS_KEY: 'secret' })).toBe(false)
  })

  it('denies a same-length key with wrong bytes', () => {
    stubTimingSafeEqual()
    const { request, url } = ask('https://dl.memlore.app/stats?key=secrat')
    expect(authorized(request, url, { DB: {} as D1Database, STATS_KEY: 'secret' })).toBe(false)
  })

  it('allows the matching key from ?key=', () => {
    stubTimingSafeEqual()
    const { request, url } = ask('https://dl.memlore.app/stats?key=secret')
    expect(authorized(request, url, { DB: {} as D1Database, STATS_KEY: 'secret' })).toBe(true)
  })

  it('allows the matching key from the X-Stats-Key header', () => {
    stubTimingSafeEqual()
    const { request, url } = ask('https://dl.memlore.app/stats', { 'x-stats-key': 'secret' })
    expect(authorized(request, url, { DB: {} as D1Database, STATS_KEY: 'secret' })).toBe(true)
  })

  it('prefers the header over the query string', () => {
    stubTimingSafeEqual()
    const { request, url } = ask('https://dl.memlore.app/stats?key=wrong!', {
      'x-stats-key': 'secret',
    })
    expect(authorized(request, url, { DB: {} as D1Database, STATS_KEY: 'secret' })).toBe(true)
  })
})

describe('logDownload', () => {
  function capture(bound: unknown[]) {
    return {
      prepare: () => ({
        bind: (...args: unknown[]) => {
          bound.push(...args)
          return { run: async () => ({}) }
        },
      }),
    } as unknown as D1Database
  }

  it('writes a minute-precision ts and a day that agrees with it', async () => {
    const bound: unknown[] = []
    await logDownload({ DB: capture(bound) }, '0.1.0', 'FR')
    // Seconds are dropped on purpose: see the comment on logDownload.
    expect(bound[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/)
    expect(bound[1]).toBe(String(bound[0]).slice(0, 10))
    expect(bound.slice(2)).toEqual(['0.1.0', 'FR', 'mac'])
  })

  it('swallows a synchronous throw from prepare instead of rejecting', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = {
      prepare: () => {
        throw new Error('no D1 binding')
      },
    } as unknown as D1Database
    // A throw here escapes ctx.waitUntil(...) and turns /mac into a 500.
    await expect(logDownload({ DB: db }, '0.1.0', 'FR')).resolves.toBeUndefined()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('esc', () => {
  it('escapes every character that could break out of HTML', () => {
    expect(esc(`<script>&"'`)).toBe('&lt;script&gt;&amp;&quot;&#39;')
  })

  it('escapes an ampersand once, not twice', () => {
    expect(esc('&lt;')).toBe('&amp;lt;')
  })

  it.each([
    [null, ''],
    [undefined, ''],
    [0, '0'],
    [false, 'false'],
  ])('renders %j as %j', (value, expected) => {
    expect(esc(value)).toBe(expected)
  })
})

// A link checker sending HEAD must get the same redirect a browser gets — HTTP
// requires HEAD wherever GET is supported — but must never land in `downloads`.
// Without this test, dropping the HEAD branch would let probes silently inflate
// the exact numbers this Worker exists to report, and nothing would go red.
describe('default export — HEAD is answered but not counted', () => {
  const LATEST = { version: '0.1.0' }

  function ctxSpy() {
    const waited: Promise<unknown>[] = []
    return {
      ctx: { waitUntil: (p: Promise<unknown>) => waited.push(p), passThroughOnException: () => {} },
      waited,
    }
  }

  function stubGithub() {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify(LATEST))))
  }

  it('redirects a HEAD to the same .dmg as a GET', async () => {
    stubGithub()
    const { ctx } = ctxSpy()
    const res = await worker.fetch(
      new Request('https://dl.memlore.app/mac', { method: 'HEAD' }),
      { DB: {} as D1Database },
      ctx as unknown as ExecutionContext,
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(
      'https://github.com/dinhanhthi/memlore/releases/download/v0.1.0/Memlore_0.1.0_universal.dmg',
    )
  })

  it('writes nothing for a HEAD', async () => {
    stubGithub()
    const { ctx, waited } = ctxSpy()
    // A bare {} as the DB: any attempt to touch it would throw, so an empty
    // `waited` is the assertion — nothing was even scheduled.
    await worker.fetch(
      new Request('https://dl.memlore.app/mac', { method: 'HEAD' }),
      { DB: {} as D1Database },
      ctx as unknown as ExecutionContext,
    )
    expect(waited).toHaveLength(0)
  })

  it('does schedule a write for a GET', async () => {
    stubGithub()
    const { ctx, waited } = ctxSpy()
    const db = { prepare: () => ({ bind: () => ({ run: () => Promise.resolve() }) }) }
    await worker.fetch(
      new Request('https://dl.memlore.app/mac'),
      { DB: db as unknown as D1Database },
      ctx as unknown as ExecutionContext,
    )
    expect(waited).toHaveLength(1)
  })

  it('still rejects a POST', async () => {
    const { ctx } = ctxSpy()
    const res = await worker.fetch(
      new Request('https://dl.memlore.app/mac', { method: 'POST' }),
      { DB: {} as D1Database },
      ctx as unknown as ExecutionContext,
    )
    expect(res.status).toBe(405)
  })
})
