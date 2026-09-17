/**
 * User-facing release notes for the website. The developer-facing counterpart is
 * the repository's CHANGELOG.md — this file is the plain-language retelling for
 * people who just want to know what changed in the app they use. No commit
 * hashes, no file paths, no internal identifiers.
 */

export type ChangelogKind = 'new' | 'improved' | 'fixed'

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
    version: '0.1.0',
    date: '2026-09-17',
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
export function latestStableVersionOf(entries: ChangelogRelease[]): string {
  const stable = entries.find((entry) => entry.stable)
  if (!stable) throw new Error('changelogData: no stable release to show')
  return stable.version
}

export const latestStableVersion = latestStableVersionOf(releases)
