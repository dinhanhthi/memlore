/**
 * Runtime config (Phase 11.4): the FAIL-CLOSED write flag.
 *
 * `WEB_WRITES_ENABLED` lives in the web-auth Worker and is served as `GET /api/config`. The web
 * app is read-only unless that answer is exactly 200 with a JSON object whose OWN property
 * `writes` is the boolean `true`. A network error, timeout, non-200, oversize or malformed body,
 * or any other shape means read-only. `fetchWriteFlag()` is THE one parser (the OAuth client
 * delegates to it) and is never memoised: it is called on unlock AND before every push batch
 * (Phase 15.4), so flipping the kill switch takes effect at the next batch.
 *
 * The module keeps only the LAST answer in RAM, for display (`capabilities.writes`). It is false
 * until the first successful fetch, drops back to false on any failed fetch, and is reset on lock.
 * Never gate a write on the cached value: re-fetch.
 */

import { listen } from '../tauri/event'
import { isUnlocked, onLock } from './keys'

const CONFIG_URL = '/api/config'
/** A hanging request means read-only. */
export const CONFIG_TIMEOUT_MS = 5_000
/** The real body is `{"writes":true}`; anything bigger is not our Worker. */
export const MAX_CONFIG_BYTES = 4096

export interface WriteFlagOptions {
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>
  timeoutMs?: number
}

class ConfigTimeoutError extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Only meaningful when both the response URL and the page location are known (not in tests). */
function isCrossOrigin(res: Response): boolean {
  if (res.redirected) return true
  if (res.url === '' || typeof location === 'undefined') return false
  try {
    return new URL(res.url).origin !== location.origin
  } catch {
    return true
  }
}

/** Body text, refusing more than `MAX_CONFIG_BYTES` BYTES (counted as they arrive, then aborted). */
async function readBoundedText(res: Response): Promise<string | null> {
  const stream = res.body
  if (stream === null) return ''
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_CONFIG_BYTES) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const all = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    all.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(all)
}

async function requestFlag(
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
  signal: AbortSignal,
): Promise<boolean> {
  const res = await fetchImpl(CONFIG_URL, {
    cache: 'no-store',
    credentials: 'same-origin',
    redirect: 'error', // a followed redirect must never decide the write flag
    signal,
  })
  if (res.status !== 200 || isCrossOrigin(res)) return false
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_CONFIG_BYTES) return false
  const text = await readBoundedText(res)
  if (text === null) return false
  const body: unknown = JSON.parse(text)
  // Own property only: `{"__proto__":{"writes":true}}` must not count.
  return isPlainObject(body) && Object.hasOwn(body, 'writes') && body.writes === true
}

/** Always hits the network. Resolves false (never rejects) on anything but an exact `true`. */
export async function fetchWriteFlag(options: WriteFlagOptions = {}): Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
  const timeoutMs = options.timeoutMs ?? CONFIG_TIMEOUT_MS
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  // Raced as well as signalled: a fetch (or body read) that ignores the signal still ends.
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new ConfigTimeoutError())
    }, timeoutMs)
  })
  try {
    return await Promise.race([requestFlag(fetchImpl, controller.signal), timeout])
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

let cached = false
// Bumped on lock so a fetch started before the lock cannot repopulate the cache after it.
let generation = 0

/** Last known flag for display only. False until the first successful fetch and after a lock. */
export const getCachedWriteFlag = (): boolean => cached

/** Test helper to override the cached write flag directly. */
export function setWriteFlagForTest(val: boolean): void {
  cached = val
}

/** What the UI layer reads (Phase 12). Not a gate for writes: `safeUpload` re-fetches. */
export function getCapabilities(): { writes: boolean } {
  return { writes: cached }
}

const flagOnListeners = new Set<() => void>()

/** Called each time the cached flag turns from off to on. Returns the unsubscribe function. */
export function onWriteFlagOn(listener: () => void): () => void {
  flagOnListeners.add(listener)
  return () => {
    flagOnListeners.delete(listener)
  }
}

/** Fetches the flag and stores it for display. Returns the fresh value. */
export async function refreshWriteFlag(options: WriteFlagOptions = {}): Promise<boolean> {
  const gen = generation
  const value = await fetchWriteFlag(options)
  if (gen === generation) {
    const turnedOn = value && !cached
    cached = value
    if (turnedOn) for (const listener of [...flagOnListeners]) listener()
  }
  return value
}

function resetWriteFlag(): void {
  generation++
  cached = false
}

let autostartInstalled = false

/** Wires `app:unlocked` (fetch the flag) and the key holder's lock hook (reset it). Idempotent. */
export function installConfigAutostart(): void {
  if (autostartInstalled) return
  autostartInstalled = true
  onLock(resetWriteFlag)
  void listen('app:unlocked', () => {
    if (isUnlocked()) void refreshWriteFlag()
  })
}
