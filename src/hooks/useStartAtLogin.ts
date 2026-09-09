import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart'
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'

// ── Module singleton ──────────────────────────────────────────────────
let cached = false
let hydrated = false
let hydrating = false
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getEnabledSnapshot(): boolean {
  return cached
}

function getHydratedSnapshot(): boolean {
  return hydrated
}

async function doHydrate(): Promise<void> {
  if (hydrated || hydrating) return
  hydrating = true
  try {
    cached = await isEnabled()
  } catch {
    cached = false
  }
  hydrated = true
  hydrating = false
  notify()
}

/** Non-reactive read — for command palette and non-React callers. */
export function getStartAtLogin(): boolean {
  return cached
}

export function isStartAtLoginHydrated(): boolean {
  return hydrated
}

/** Imperative setter — for command palette and non-React callers. */
export async function setStartAtLogin(next: boolean): Promise<void> {
  if (next) {
    await enable()
  } else {
    await disable()
  }
  cached = next
  hydrated = true
  notify()
}

export function useStartAtLogin() {
  const enabled = useSyncExternalStore(subscribe, getEnabledSnapshot, getEnabledSnapshot)
  const loading = !useSyncExternalStore(subscribe, getHydratedSnapshot, getHydratedSnapshot)

  useEffect(() => {
    void doHydrate()
  }, [])

  const toggle = useCallback(async (value: boolean) => {
    const prev = cached
    // Optimistic update
    cached = value
    notify()
    try {
      await setStartAtLogin(value)
    } catch {
      cached = prev
      notify()
    }
  }, [])

  return useMemo(() => ({ enabled, loading, toggle }), [enabled, loading, toggle])
}

/** Test-only: reset module state between cases. */
export function __resetStartAtLoginForTests(): void {
  cached = false
  hydrated = false
  hydrating = false
  listeners.clear()
}
