// Lightweight synchronous platform detection.
//
// Tauri 2's official `@tauri-apps/plugin-os` would give us `platform()`,
// but the plugin is not installed in this project. The webview process
// uses macOS WebKit on macOS and reports a Mac userAgent — that's enough
// to gate the macOS-only "Photo Library" affordances at render time.
//
// The result is cached because `navigator` is stable for the session.

let cached: 'macos' | 'other' | null = null

export function detectPlatform(): 'macos' | 'other' {
  if (cached !== null) return cached
  if (typeof navigator === 'undefined') {
    cached = 'other'
    return cached
  }
  const haystack = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`.toLowerCase()
  cached = haystack.includes('mac') ? 'macos' : 'other'
  return cached
}

/** True only in the web.memlore.app build (set by `web/vite.config.ts`). */
export const isWeb: boolean = import.meta.env.VITE_MEMLORE_PLATFORM === 'web'

export function isMacOS(): boolean {
  // A Mac browser must not expose the Tauri/Swift Photo Library affordances.
  if (isWeb) return false
  return detectPlatform() === 'macos'
}

export interface Capabilities {
  windowChrome: boolean
  biometric: boolean
  icloud: boolean
  ai: boolean
  dashboard: boolean
  maps: boolean
  chat: boolean
  reminders: boolean
  importExport: boolean
  versions: boolean
  secondLock: boolean
  onDeviceModels: boolean
  updater: boolean
  writes: boolean
}

/** Static capabilities: every feature on desktop; none on web. `writes` on web is
 * overridden at runtime by `capabilitiesStore` (see `useCapabilities`). */
export const capabilities: Capabilities = {
  windowChrome: !isWeb,
  biometric: !isWeb,
  icloud: !isWeb,
  ai: !isWeb,
  dashboard: !isWeb,
  maps: !isWeb,
  chat: !isWeb,
  reminders: !isWeb,
  importExport: !isWeb,
  versions: !isWeb,
  secondLock: !isWeb,
  onDeviceModels: !isWeb,
  updater: !isWeb,
  writes: !isWeb,
}
