import { expect, it } from 'vitest'
import changelogHtml from '../changelog.html?raw'
import { changelog } from '../src/content'
import {
  latestStableVersion,
  latestStableVersionOf,
  releases,
  type ChangelogRelease,
} from '../src/changelog/changelogData'

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function release(version: string, date: string, stable: boolean): ChangelogRelease {
  return { version, date, stable, items: [{ kind: 'new', text: 'Something changed.' }] }
}

it('never shows a prerelease version on the public site', () => {
  const entries = [
    release('0.2.0-beta.1', '2026-10-01', false),
    release('0.1.0', '2026-09-17', true),
  ]
  expect(latestStableVersionOf(entries)).toBe('0.1.0')
})

it('shows the newest stable version, skipping every prerelease above it', () => {
  const entries = [
    release('0.3.0-beta.2', '2026-12-01', false),
    release('0.3.0-beta.1', '2026-11-01', false),
    release('0.2.0', '2026-10-01', true),
    release('0.1.0', '2026-09-17', true),
  ]
  expect(latestStableVersionOf(entries)).toBe('0.2.0')
})

it('refuses to fabricate a version when no release is stable', () => {
  expect(() => latestStableVersionOf([release('0.2.0-beta.1', '2026-10-01', false)])).toThrow(
    /no stable release/,
  )
})

it('exposes a stable, non-prerelease version from the real data', () => {
  const shown = releases.find((entry) => entry.version === latestStableVersion)
  expect(shown?.stable).toBe(true)
  expect(latestStableVersion).not.toContain('-')
})

it('lists releases newest first', () => {
  const dates = releases.map((entry) => entry.date)
  expect(dates).toEqual([...dates].sort().reverse())
})

it('uses bare semver versions and ISO dates', () => {
  expect(releases.length).toBeGreaterThan(0)
  for (const entry of releases) {
    expect(entry.version, entry.version).toMatch(SEMVER)
    expect(entry.date, entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(entry.items.length, entry.version).toBeGreaterThan(0)
  }
})

it('keeps the notes readable for someone who does not read code', () => {
  const copy = releases.flatMap((entry) => entry.items.map((item) => item.text)).join('\n')
  expect(copy).not.toMatch(/\b[0-9a-f]{7,40}\b/) // commit hashes
  expect(copy).not.toMatch(/src-tauri|\.rs\b|\.tsx?\b|tauri\.conf/) // file paths
  expect(copy).not.toMatch(/minisign|notariz|entitlement|tauri-plugin|universal binary/i)
})

it('keeps the changelog page title and description in sync with the copy source', () => {
  expect(changelogHtml).toContain(`<title>${changelog.metaTitle}</title>`)
  expect(changelogHtml).toContain(`content="${changelog.metaDescription}"`)
})
