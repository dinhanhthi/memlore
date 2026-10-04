/**
 * User-facing release notes for the website. The developer-facing counterpart is
 * the repository's CHANGELOG.md — this file is the plain-language retelling for
 * people who just want to know what changed in the app they use. No commit
 * hashes, no file paths, no internal identifiers.
 */

export type ChangelogKind = 'new' | 'improved' | 'fixed' | 'breaking'

/** The desktop app (`v*` tags) or the web companion (`web-v*` tags). Each has its own versions. */
export type ChangelogPlatform = 'mac' | 'web'

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
  /** Absent means `'mac'`: every release before the web companion was the desktop app. */
  platform?: ChangelogPlatform
  items: ChangelogItem[]
}

/** Newest release first. */
export const releases: ChangelogRelease[] = [
  {
    version: '0.1.0',
    date: '2026-10-05',
    stable: true,
    platform: 'web',
    items: [
      {
        kind: 'new',
        text: 'Memlore Web: open your journal in any browser. Sign in with Google, enter your recovery phrase, and read and search your entries and media. Your keys stay in your browser and nothing goes through a Memlore server. You create your vault on the desktop first.',
      },
      {
        kind: 'new',
        text: 'Edits made on the web are saved to a private outbox on your Google Drive, and your desktop app merges them on its next sync. If you change the same thing on both, your desktop wins, and the web never deletes anything. Editing on the web is switched on separately and starts off.',
      },
    ],
  },
  {
    version: '0.2.1',
    date: '2026-10-01',
    stable: true,
    items: [
      {
        kind: 'new',
        text: 'Statistics and Home now open with a story in numbers: how many entries and words you wrote, your streak, your mood, the days you showed up this year, and the hour you usually write. Each number has a small chart for the period you pick, and home cards use the same style with an icon next to the title.',
      },
    ],
  },
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
        text: 'First public release. A private journal on your Mac, with signed updates, a Beta channel, and Touch ID unlock. Requires macOS 13 or later.',
      },
    ],
  },
]

/**
 * Exported for the test that proves a prerelease can never reach the badge: with
 * a beta bump sitting at the top of `releases`, the public site must still show
 * the last stable version.
 */
export function platformOf(release: ChangelogRelease): ChangelogPlatform {
  return release.platform ?? 'mac'
}

/** The site badge is the downloadable desktop app: web releases never reach it. */
export function latestStableReleaseOf(entries: ChangelogRelease[]): ChangelogRelease {
  const stable = entries.find((entry) => entry.stable && platformOf(entry) === 'mac')
  if (!stable) throw new Error('changelogData: no stable release to show')
  return stable
}

export function latestStableVersionOf(entries: ChangelogRelease[]): string {
  return latestStableReleaseOf(entries).version
}

export const latestStableRelease = latestStableReleaseOf(releases)
export const latestStableVersion = latestStableRelease.version

/** The release's tag: `v0.2.1` for the desktop app, `web-v0.1.0` for the web companion. */
export function releaseAnchorId(release: ChangelogRelease): string {
  return `${platformOf(release) === 'web' ? 'web-' : ''}v${release.version}`
}
