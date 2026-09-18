// Pure helpers for resolving the current macOS download URL. No I/O, so the
// version-string guard below is unit-testable — see releases.test.ts.

export const REPO = 'dinhanhthi/memlore'
export const RELEASES_URL = `https://github.com/${REPO}/releases`

/** Served through the GitHub CDN, no API rate limit. Safe to hit per request. */
export const LATEST_JSON_URL = `${RELEASES_URL}/latest/download/latest.json`

/** Where /mac goes when resolution fails. The Download button must never die. */
export const FALLBACK_URL = `${RELEASES_URL}/latest`

const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

/**
 * The guard that stops an unexpected `latest.json` value being interpolated
 * into a URL.
 */
export function isValidVersion(v: unknown): v is string {
  return typeof v === 'string' && VERSION_RE.test(v)
}

export function dmgUrl(version: string): string {
  return `${RELEASES_URL}/download/v${version}/Memlore_${version}_universal.dmg`
}

export function versionFromLatestJson(json: unknown): string | null {
  const version = (json as { version?: unknown } | null)?.version
  return isValidVersion(version) ? version : null
}
