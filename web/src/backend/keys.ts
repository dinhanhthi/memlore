import type { Core } from '../core/core'
import { emitFromBackend } from '../tauri/event'
import { ERROR_NAMES } from './errorNames'

/** The WASM key ring (its constructor is private in the d.ts, hence the alias). */
export type KeyRing = ReturnType<Core['KeyRing']['fromRecovery']>

export type LockReason = 'manual' | 'idle' | 'hidden' | 'revoked' | 'format'

export class VaultLockedError extends Error {
  constructor() {
    super('vault is locked')
    this.name = ERROR_NAMES.vaultLocked
  }
}

const DEFAULT_IDLE_MINUTES = 15
const MIN_IDLE_MINUTES = 1
const MAX_IDLE_MINUTES = 24 * 60
const HIDDEN_LIMIT_MS = 5 * 60 * 1000
const ACTIVITY_THROTTLE_MS = 1000
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const

interface Target {
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}
interface DocumentLike extends Target {
  visibilityState: string
}

/** Injectable environment. Defaults resolve lazily so importing has no side effects. */
export interface KeysEnv {
  now: () => number
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  emit: (event: string, payload?: unknown) => void
  document: DocumentLike | null
  window: Target | null
}

function defaultEnv(): KeysEnv {
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
    emit: emitFromBackend,
    document: typeof document === 'undefined' ? null : (document as unknown as DocumentLike),
    window: typeof window === 'undefined' ? null : (window as unknown as Target),
  }
}

let injected: Partial<KeysEnv> = {}
const resolveEnv = (): KeysEnv => ({ ...defaultEnv(), ...injected })

let ring: KeyRing | null = null
let idleMinutes = DEFAULT_IDLE_MINUTES
const hooks = new Set<() => void>()

let idleTimer: unknown = null
let hiddenTimer: unknown = null
let hiddenAt: number | null = null
let lastActivity = 0
let watching: { e: KeysEnv; remove: () => void } | null = null

/** Test seam: override injected pieces. Pass `{}` to restore the defaults. */
export function configureKeysEnv(partial: Partial<KeysEnv>): void {
  injected = partial
}

/**
 * Auto-lock minutes from the synced settings. null/NaN/<=0/non-number fall back to the
 * default. Desktop's auto-lock settings (`*_auto_lock_minutes`, options 1/5/15/30 and
 * 0 = "never") belong to the second/invisible locks, but if "never" (0) ever arrives
 * here it is NOT honoured: a browser tab is less trusted, so it becomes the 15 min
 * default. Other values are clamped to [1, 24*60].
 */
export function setAutoLockMinutes(minutes: number | null): void {
  idleMinutes =
    typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0
      ? Math.min(MAX_IDLE_MINUTES, Math.max(MIN_IDLE_MINUTES, minutes))
      : DEFAULT_IDLE_MINUTES
  if (watching) resetIdle()
}

export const getAutoLockMinutes = (): number => idleMinutes

export function onLock(cb: () => void): () => void {
  hooks.add(cb)
  return () => {
    hooks.delete(cb)
  }
}

export const isUnlocked = (): boolean => ring !== null

export function getKeyRing(): KeyRing {
  if (!ring) throw new VaultLockedError()
  return ring
}

function resetIdle(): void {
  if (!watching) return
  const { e } = watching
  if (idleTimer !== null) e.clearTimeout(idleTimer)
  lastActivity = e.now()
  idleTimer = e.setTimeout(() => lock('idle'), idleMinutes * 60 * 1000)
}

/** Reset the idle timer (user activity). */
export function touch(): void {
  resetIdle()
}

function stopWatchers(): void {
  if (!watching) return
  const { e, remove } = watching
  watching = null
  if (idleTimer !== null) e.clearTimeout(idleTimer)
  if (hiddenTimer !== null) e.clearTimeout(hiddenTimer)
  idleTimer = null
  hiddenTimer = null
  hiddenAt = null
  remove()
}

function startWatchers(): void {
  const e = resolveEnv()
  const onActivity = (): void => {
    if (e.now() - lastActivity >= ACTIVITY_THROTTLE_MS) resetIdle()
  }
  const onVisibility = (): void => {
    if (!e.document) return
    if (e.document.visibilityState === 'hidden') {
      if (hiddenAt !== null) return
      hiddenAt = e.now()
      hiddenTimer = e.setTimeout(() => lock('hidden'), HIDDEN_LIMIT_MS)
      return
    }
    if (hiddenTimer !== null) e.clearTimeout(hiddenTimer)
    hiddenTimer = null
    const since = hiddenAt
    hiddenAt = null
    // Background tabs throttle timers, so trust the wall clock on return.
    if (since !== null && e.now() - since > HIDDEN_LIMIT_MS) {
      lock('hidden')
      return
    }
    resetIdle()
  }
  const { window: win, document: doc } = e
  for (const t of ACTIVITY_EVENTS) win?.addEventListener(t, onActivity)
  doc?.addEventListener('visibilitychange', onVisibility)
  watching = {
    e,
    remove: () => {
      for (const t of ACTIVITY_EVENTS) win?.removeEventListener(t, onActivity)
      doc?.removeEventListener('visibilitychange', onVisibility)
    },
  }
  resetIdle()
  // A ring installed while the tab is already hidden must start the hidden timer too.
  if (doc?.visibilityState === 'hidden') onVisibility()
}

function safeLockRing(r: KeyRing): void {
  try {
    r.lock()
  } catch (err) {
    console.error('[keys] ring.lock() failed', err)
  }
}

/** Install the ring after a successful unlock/onboard; locks any previous ring. */
export function setKeyRing(next: KeyRing): void {
  stopWatchers()
  if (ring && ring !== next) safeLockRing(ring)
  ring = next
  startWatchers()
}

/** Idempotent, never throws: zeroize, drop handle, run every hook, emit once. */
export function lock(reason: LockReason): void {
  const r = ring
  if (!r) return
  ring = null
  stopWatchers()
  safeLockRing(r)
  for (const hook of [...hooks]) {
    try {
      hook()
    } catch (err) {
      console.error('[keys] lock hook threw', reason, err)
    }
  }
  try {
    resolveEnv().emit('app:locked')
  } catch (err) {
    console.error('[keys] emit app:locked failed', err)
  }
}

/** Tests only: drop everything without emitting or running hooks. */
export function dispose(): void {
  stopWatchers()
  if (ring) safeLockRing(ring)
  ring = null
  hooks.clear()
  idleMinutes = DEFAULT_IDLE_MINUTES
  injected = {}
}
