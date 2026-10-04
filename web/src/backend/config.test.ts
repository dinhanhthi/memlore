import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONFIG_TIMEOUT_MS,
  MAX_CONFIG_BYTES,
  fetchWriteFlag,
  getCachedWriteFlag,
  getCapabilities,
  onWriteFlagOn,
  refreshWriteFlag,
} from './config'
import { dispose, lock, setKeyRing, type KeyRing } from './keys'

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status })
const raw = (text: string, status = 200): Response => new Response(text, { status })
const run = (impl: FetchImpl): Promise<boolean> => fetchWriteFlag({ fetchImpl: impl })

describe('fetchWriteFlag', () => {
  it('is true only for 200 + {writes:true}', async () => {
    expect(await run(async () => json({ writes: true }))).toBe(true)
    expect(await run(async () => raw('{"writes":true,"other":1}'))).toBe(true)
  })

  it('requests /api/config no-store, same-origin, with an abort signal', async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => json({ writes: true }))
    await run(fetchImpl)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/config')
    expect(init?.cache).toBe('no-store')
    expect(init?.credentials).toBe('same-origin')
    expect(init?.redirect).toBe('error')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('is false for every non-exact-true body', async () => {
    const bodies = [
      { writes: false },
      {},
      { writes: '1' },
      { writes: 1 },
      { writes: 'true' },
      { writes: null },
      { writes: [true] },
      { writes: { writes: true } },
      { WRITES: true },
      null,
      [],
      [{ writes: true }],
      'true',
      1,
      true,
    ]
    for (const body of bodies) expect(await run(async () => json(body))).toBe(false)
  })

  it('does not honour an inherited writes (prototype tricks)', async () => {
    expect(await run(async () => raw('{"__proto__":{"writes":true}}'))).toBe(false)
    expect(await run(async () => raw('{"constructor":{"prototype":{"writes":true}}}'))).toBe(false)
  })

  it('is false for malformed or empty JSON', async () => {
    expect(await run(async () => raw('not json'))).toBe(false)
    expect(await run(async () => raw('{"writes":true'))).toBe(false)
    expect(await run(async () => raw(''))).toBe(false)
  })

  it('counts only status 200', async () => {
    for (const status of [201, 204, 299, 301, 304, 400, 401, 403, 404, 500, 503]) {
      const res = json({ writes: true })
      Object.defineProperty(res, 'status', { value: status })
      expect(await run(async () => res)).toBe(false)
    }
  })

  it('is false when fetch rejects', async () => {
    expect(await run(() => Promise.reject(new TypeError('offline')))).toBe(false)
  })

  it('is false for an oversize body, declared or actual', async () => {
    const pad = ' '.repeat(MAX_CONFIG_BYTES)
    expect(await run(async () => raw(`{"writes":true}${pad}`))).toBe(false)
    const declared = new Response('{"writes":true}', {
      headers: { 'content-length': String(MAX_CONFIG_BYTES + 1) },
    })
    expect(await run(async () => declared)).toBe(false)
  })

  it('is false for a redirected response or one from another origin', async () => {
    const redirected = json({ writes: true })
    Object.defineProperty(redirected, 'redirected', { value: true })
    expect(await run(async () => redirected)).toBe(false)

    vi.stubGlobal('location', { origin: 'https://app.example' })
    try {
      const foreign = json({ writes: true })
      Object.defineProperty(foreign, 'url', { value: 'https://evil.example/api/config' })
      expect(await run(async () => foreign)).toBe(false)
      const own = json({ writes: true })
      Object.defineProperty(own, 'url', { value: 'https://app.example/api/config' })
      expect(await run(async () => own)).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('counts bytes, not characters, and stops reading an oversize chunked body', async () => {
    // 3 bytes per character: under the cap as characters, over it as bytes.
    const wide = `{"writes":true,"p":"${'\u20ac'.repeat(MAX_CONFIG_BYTES / 2)}"}`
    expect(wide.length).toBeLessThan(MAX_CONFIG_BYTES * 2)
    expect(await run(async () => raw(wide))).toBe(false)

    let pulled = 0
    const chunk = new Uint8Array(MAX_CONFIG_BYTES)
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1
        controller.enqueue(chunk)
      },
    })
    expect(await run(async () => new Response(stream, { status: 200 }))).toBe(false)
    expect(pulled).toBeLessThanOrEqual(3) // aborted, not drained (the stream never ends)
  })

  describe('timeout', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('is false and aborts when the request hangs', async () => {
      let signal: AbortSignal | undefined
      const never: FetchImpl = (_url, init) => {
        signal = init?.signal ?? undefined
        return new Promise<Response>(() => undefined)
      }
      const p = fetchWriteFlag({ fetchImpl: never })
      await vi.advanceTimersByTimeAsync(CONFIG_TIMEOUT_MS)
      expect(await p).toBe(false)
      expect(signal?.aborted).toBe(true)
    })

    it('is false when the body read hangs', async () => {
      const hang = {
        status: 200,
        headers: new Headers(),
        body: { getReader: () => ({ read: () => new Promise(() => undefined) }) },
      } as unknown as Response
      const p = fetchWriteFlag({ fetchImpl: async () => hang, timeoutMs: 100 })
      await vi.advanceTimersByTimeAsync(100)
      expect(await p).toBe(false)
    })

    it('does not time out a prompt answer', async () => {
      const p = fetchWriteFlag({ fetchImpl: async () => json({ writes: true }) })
      expect(await p).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  it('is never memoised: the kill switch flips on the next call', async () => {
    const answers = [json({ writes: true }), json({ writes: false })]
    const fetchImpl = vi.fn<FetchImpl>(async () => answers.shift() as Response)
    expect(await run(fetchImpl)).toBe(true)
    expect(await run(fetchImpl)).toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})

describe('cached flag', () => {
  const ring = { lock: () => undefined } as unknown as KeyRing
  beforeEach(() => {
    setKeyRing(ring)
    lock('manual')
  })
  afterEach(() => dispose())

  it('is false until the first successful fetch; capabilities mirror it', async () => {
    expect(getCachedWriteFlag()).toBe(false)
    expect(getCapabilities()).toEqual({ writes: false })
    expect(await refreshWriteFlag({ fetchImpl: async () => json({ writes: true }) })).toBe(true)
    expect(getCachedWriteFlag()).toBe(true)
    expect(getCapabilities()).toEqual({ writes: true })
  })

  it('flips back to false when a later fetch fails', async () => {
    await refreshWriteFlag({ fetchImpl: async () => json({ writes: true }) })
    await refreshWriteFlag({ fetchImpl: () => Promise.reject(new TypeError('offline')) })
    expect(getCachedWriteFlag()).toBe(false)
  })

  it('notifies onWriteFlagOn only when the cached flag turns on', async () => {
    const seen = vi.fn()
    const off = onWriteFlagOn(seen)
    await refreshWriteFlag({ fetchImpl: async () => json({ writes: false }) })
    expect(seen).not.toHaveBeenCalled()
    await refreshWriteFlag({ fetchImpl: async () => json({ writes: true }) })
    await refreshWriteFlag({ fetchImpl: async () => json({ writes: true }) })
    expect(seen).toHaveBeenCalledTimes(1)
    off()
    await refreshWriteFlag({ fetchImpl: async () => json({ writes: false }) })
    await refreshWriteFlag({ fetchImpl: async () => json({ writes: true }) })
    expect(seen).toHaveBeenCalledTimes(1)
    await refreshWriteFlag({ fetchImpl: async () => json({ writes: false }) })
  })

  it('a bare fetchWriteFlag does not touch the cache', async () => {
    await run(async () => json({ writes: true }))
    expect(getCachedWriteFlag()).toBe(false)
  })
})

describe('autostart', () => {
  const ring = { lock: () => undefined } as unknown as KeyRing
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.resetModules()
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })
  afterEach(() => {
    fetchSpy.mockRestore()
    vi.resetModules()
  })

  async function boot() {
    const keys = await import('./keys')
    const config = await import('./config')
    const event = await import('../tauri/event')
    config.installConfigAutostart()
    config.installConfigAutostart() // idempotent
    return { keys, config, event }
  }
  const settle = () => new Promise((r) => setTimeout(r, 0))

  it('unlock fetches once and caches; lock resets to false', async () => {
    fetchSpy.mockImplementation(async () => json({ writes: true }))
    const { keys, config, event } = await boot()
    keys.setKeyRing(ring)
    event.emitFromBackend('app:unlocked')
    await settle()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(config.getCachedWriteFlag()).toBe(true)
    keys.lock('manual')
    expect(config.getCachedWriteFlag()).toBe(false)
    keys.dispose()
  })

  it('does not fetch when the vault is not unlocked', async () => {
    fetchSpy.mockImplementation(async () => json({ writes: true }))
    const { keys, event } = await boot()
    event.emitFromBackend('app:unlocked')
    await settle()
    expect(fetchSpy).not.toHaveBeenCalled()
    keys.dispose()
  })

  it('a failing fetch on unlock is swallowed and leaves false', async () => {
    fetchSpy.mockImplementation(() => Promise.reject(new TypeError('offline')))
    const { keys, config, event } = await boot()
    keys.setKeyRing(ring)
    event.emitFromBackend('app:unlocked')
    await settle()
    expect(config.getCachedWriteFlag()).toBe(false)
    keys.dispose()
  })

  it('a fetch resolving after a lock does not repopulate the cache', async () => {
    let release: (r: Response) => void = () => undefined
    fetchSpy.mockImplementation(() => new Promise<Response>((r) => (release = r)))
    const { keys, config, event } = await boot()
    keys.setKeyRing(ring)
    event.emitFromBackend('app:unlocked')
    await settle()
    keys.lock('manual')
    release(json({ writes: true }))
    await settle()
    expect(config.getCachedWriteFlag()).toBe(false)
    keys.dispose()
  })
})
