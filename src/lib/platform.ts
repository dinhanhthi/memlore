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

export function isMacOS(): boolean {
  return detectPlatform() === 'macos'
}
