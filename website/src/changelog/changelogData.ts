/**
 * User-facing release notes for the website. The developer-facing counterpart is
 * the repository's CHANGELOG.md — this file is the plain-language retelling for
 * people who just want to know what changed in the app they use. No commit
 * hashes, no file paths, no internal identifiers.
 */

export type ChangelogKind = 'new' | 'improved' | 'fixed' | 'breaking'

export type ChangelogItem = {
  kind: ChangelogKind
  text: string
}

export type ChangelogRelease = {
  /** Bare semver, no leading `v` — the badge and headings add it. */
  version: string
  /** ISO `YYYY-MM-DD`, rendered in UTC so the day never shifts. */
  date: string
  /** `false` marks a prerelease; it is shown with a Beta marker and never becomes `latestStableVersion`. */
  stable: boolean
  items: ChangelogItem[]
}

/** Newest release first. */
export const releases: ChangelogRelease[] = [
  {
    version: '0.2.0',
    date: '2026-09-21',
    stable: true,
    items: [
      {
        kind: 'new',
        text: 'Let other apps on your Mac read and write your journal through MCP. Turn it on in Settings → AI, paste the config into Claude Desktop or another MCP client, and they can list journals, search and open entries, and create or update them. It stays off until you say yes, and it works even if you have not set up an AI provider.',
      },
      {
        kind: 'fixed',
        text: 'Clay’s sidebar navigation highlights again when you hover an item.',
      },
    ],
  },
  {
    version: '0.1.1',
    date: '2026-09-18',
    stable: true,
    items: [
      {
        kind: 'fixed',
        text: 'Updates no longer freeze the app while installing. Memlore downloads and installs in the background, then asks you to restart when it is ready, and shows the release notes properly formatted.',
      },
      {
        kind: 'improved',
        text: 'Refreshed the About panel with current author, website and license info.',
      },
    ],
  },
  {
    version: '0.1.0',
    date: '2026-09-18',
    stable: true,
    items: [
      {
        kind: 'new',
        text: 'Memlore is out for Mac. Apple checks the download before it reaches you, so macOS opens the app without warning you about an unknown developer. It runs on macOS 13 and later, on both Apple silicon and Intel Macs.',
      },
      {
        kind: 'new',
        text: 'Memlore now tells you when a new version is available. Pick "Check For Updates…" from the Memlore menu whenever you like, and the app also checks quietly each time you open it.',
      },
      {
        kind: 'new',
        text: 'Every update is checked against Memlore’s own signature before it installs, so a download that has been tampered with is refused instead of installed.',
      },
      {
        kind: 'new',
        text: 'Want new features early? Switch to the Beta channel in Settings and updates will include test versions. Stay on Stable for the polished ones.',
      },
      {
        kind: 'new',
        text: 'Unlock your journal with Touch ID instead of typing your password every time.',
      },
      {
        kind: 'improved',
        text: 'The automatic update check can be turned off in Settings → General if you would rather look for updates yourself.',
      },
    ],
  },
]

/**
 * Exported for the test that proves a prerelease can never reach the badge: with
 * a beta bump sitting at the top of `releases`, the public site must still show
 * the last stable version.
 */
export function latestStableReleaseOf(entries: ChangelogRelease[]): ChangelogRelease {
  const stable = entries.find((entry) => entry.stable)
  if (!stable) throw new Error('changelogData: no stable release to show')
  return stable
}

export function latestStableVersionOf(entries: ChangelogRelease[]): string {
  return latestStableReleaseOf(entries).version
}

export const latestStableRelease = latestStableReleaseOf(releases)
export const latestStableVersion = latestStableRelease.version

export function releaseAnchorId(version: string): string {
  return `v${version}`
}
