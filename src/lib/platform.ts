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
  stats: boolean
  maps: boolean
  chat: boolean
  reminders: boolean
  importExport: boolean
  versions: boolean
  secondLock: boolean
  onDeviceModels: boolean
  /** App updates; also covers start-at-login and uninstall. */
  updater: boolean
  /** Gallery media view. */
  gallery: boolean
  /** "On this day" lookback. */
  lookback: boolean
  /** Journal/tag/template create, edit, delete. */
  taxonomyEdits: boolean
  /** Soft-deleting entries. */
  deleteEntries: boolean
  /** Entry Trash: restore, delete forever, empty. */
  trash: boolean
  /** Voice memo recording. */
  audioRecording: boolean
  /** Attaching files to entries. */
  fileAttachments: boolean
  /** Custom Google font download and font cache. */
  fontDownloads: boolean
  /** Sync admin: disconnect, recovery wizard, schedule, devices, upload limits, compression, sync toggles. */
  syncAdmin: boolean
  /** Security settings: password, rotation, recovery. */
  vaultAdmin: boolean
  writes: boolean
  /** Reading Daily Chat sessions (read-only on web; sending still needs `ai`). */
  chatRead: boolean
  /** Reading memory items and the persona (read-only on web; editing still needs `ai`). */
  memoryRead: boolean
  /** Writing streak. */
  streak: boolean
  /** Exporting one entry as Markdown. */
  entryMarkdownExport: boolean
}

/** Static capabilities: every feature on desktop; on web only the read-only flags
 * at the end. `writes` on web is overridden at runtime by `capabilitiesStore`
 * (see `useCapabilities`). */
export const capabilities: Capabilities = {
  windowChrome: !isWeb,
  biometric: !isWeb,
  icloud: !isWeb,
  ai: !isWeb,
  dashboard: !isWeb,
  stats: !isWeb,
  maps: !isWeb,
  chat: !isWeb,
  reminders: !isWeb,
  importExport: !isWeb,
  versions: !isWeb,
  secondLock: !isWeb,
  onDeviceModels: !isWeb,
  updater: !isWeb,
  gallery: !isWeb,
  lookback: !isWeb,
  taxonomyEdits: !isWeb,
  deleteEntries: !isWeb,
  trash: !isWeb,
  audioRecording: !isWeb,
  fileAttachments: !isWeb,
  fontDownloads: !isWeb,
  syncAdmin: !isWeb,
  vaultAdmin: !isWeb,
  writes: !isWeb,
  chatRead: true,
  memoryRead: true,
  streak: true,
  entryMarkdownExport: true,
}
