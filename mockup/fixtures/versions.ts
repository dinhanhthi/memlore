import type { VersionMeta } from '../../src/lib/tauri'
import { buildBlocks } from './content'
import { ENTRY_1_ID, ENTRY_2_ID, ENTRY_3_ID, FRESH_START_PARAGRAPHS } from './entries'
import { MEDIA_5_ID } from './media'

const HOUR = 3_600
const MINUTE = 60

function hoursAgo(n: number): number {
  return Math.floor(Date.now() / 1000) - n * HOUR
}

function minutesAgo(n: number): number {
  return Math.floor(Date.now() / 1000) - n * MINUTE
}

const WEB_DEVICE = 'web-preview-device'
const MACBOOK_DEVICE = 'device-macbook-home'
const IPHONE_DEVICE = 'device-iphone'

interface VersionFixture {
  meta: VersionMeta
  content: number[]
}

function paragraphsOnly(texts: string[]): number[] {
  return buildBlocks(texts.map((text) => ({ type: 'paragraph' as const, text })))
}

/** Ordered oldest → newest; reversed when exposed as version list (newest first). */
const VERSION_FIXTURES: Record<string, VersionFixture[]> = {
  [ENTRY_1_ID]: [
    {
      meta: {
        id: 'version-0001-1',
        createdAt: hoursAgo(5),
        previewText:
          'Woke up early and felt genuinely optimistic about the week ahead. Made coffee and sat on the balcony.',
        deviceId: IPHONE_DEVICE,
      },
      content: paragraphsOnly([FRESH_START_PARAGRAPHS[0]!, FRESH_START_PARAGRAPHS[1]!]),
    },
    {
      meta: {
        id: 'version-0001-2',
        createdAt: hoursAgo(4),
        previewText:
          'I have been thinking about what a fresh start actually means. It is not erasing the past or pretending yesterday did not happen.',
        deviceId: MACBOOK_DEVICE,
      },
      content: paragraphsOnly(FRESH_START_PARAGRAPHS.slice(0, 8)),
    },
    {
      meta: {
        id: 'version-0001-3',
        createdAt: hoursAgo(2),
        previewText:
          'Last month I wrote that I wanted to write longer entries. This one is deliberately long so I can scroll through the editor.',
        deviceId: WEB_DEVICE,
      },
      content: buildBlocks([
        ...FRESH_START_PARAGRAPHS.slice(0, 12).map((text) => ({
          type: 'paragraph' as const,
          text,
        })),
        {
          type: 'image' as const,
          mediaId: MEDIA_5_ID,
          alt: 'Morning light on the balcony',
        },
        ...FRESH_START_PARAGRAPHS.slice(12, 18).map((text) => ({
          type: 'paragraph' as const,
          text,
        })),
      ]),
    },
    {
      meta: {
        id: 'version-0001-4',
        createdAt: minutesAgo(45),
        previewText:
          'If you are reading this in a preview build, scroll until your thumb tires. The editor should not jitter.',
        deviceId: MACBOOK_DEVICE,
      },
      content: buildBlocks([
        ...FRESH_START_PARAGRAPHS.slice(0, 24).map((text) => ({
          type: 'paragraph' as const,
          text,
        })),
        {
          type: 'image' as const,
          mediaId: MEDIA_5_ID,
          alt: 'Morning light on the balcony',
        },
        ...FRESH_START_PARAGRAPHS.slice(24, 28).map((text) => ({
          type: 'paragraph' as const,
          text,
        })),
      ]),
    },
  ],
  [ENTRY_2_ID]: [
    {
      meta: {
        id: 'version-0002-1',
        createdAt: hoursAgo(28),
        previewText: 'Finished all my tasks today. Feeling productive.',
        deviceId: IPHONE_DEVICE,
      },
      content: paragraphsOnly(['Finished all my tasks today. Feeling productive.']),
    },
    {
      meta: {
        id: 'version-0002-2',
        createdAt: hoursAgo(26),
        previewText: 'Got through my entire task list before lunch.',
        deviceId: WEB_DEVICE,
      },
      content: paragraphsOnly([
        'Got through my entire task list before lunch.',
        'Still need to get outside for a bit of air.',
      ]),
    },
    {
      meta: {
        id: 'version-0002-3',
        createdAt: hoursAgo(24),
        previewText:
          'Got through my entire task list before lunch. Treated myself to a long walk in the park afterwards.',
        deviceId: MACBOOK_DEVICE,
      },
      content: paragraphsOnly([
        'Got through my entire task list before lunch. Treated myself to a long walk in the park afterwards.',
        'The weather was perfect — cool breeze, golden leaves, no urgency anywhere.',
      ]),
    },
  ],
  [ENTRY_3_ID]: [
    {
      meta: {
        id: 'version-0003-1',
        createdAt: hoursAgo(50),
        previewText: 'Quiet night.',
        deviceId: IPHONE_DEVICE,
      },
      content: paragraphsOnly(['Quiet night.']),
    },
    {
      meta: {
        id: 'version-0003-2',
        createdAt: hoursAgo(48),
        previewText: 'Cooked dinner, read for an hour.',
        deviceId: WEB_DEVICE,
      },
      content: paragraphsOnly([
        'Cooked dinner, read for an hour.',
        'Nothing dramatic — just a slow evening at home.',
      ]),
    },
    {
      meta: {
        id: 'version-0003-3',
        createdAt: hoursAgo(46),
        previewText:
          'Not much to report — cooked dinner, read for an hour, early to bed. Sometimes ordinary is exactly right.',
        deviceId: MACBOOK_DEVICE,
      },
      content: paragraphsOnly([
        'Not much to report — cooked dinner, read for an hour, early to bed. Sometimes ordinary is exactly right.',
        'I keep forgetting that quiet days are not wasted days. They are the ones that let the loud ones land.',
      ]),
    },
  ],
}

function buildLookupMaps(): {
  versionsByEntry: Record<string, VersionMeta[]>
  versionContentById: Record<string, number[]>
  versionEntryById: Record<string, string>
} {
  const versionsByEntry: Record<string, VersionMeta[]> = {}
  const versionContentById: Record<string, number[]> = {}
  const versionEntryById: Record<string, string> = {}

  for (const [entryId, fixtures] of Object.entries(VERSION_FIXTURES)) {
    versionsByEntry[entryId] = fixtures
      .map((f) => f.meta)
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
    for (const fixture of fixtures) {
      versionContentById[fixture.meta.id] = fixture.content
      versionEntryById[fixture.meta.id] = entryId
    }
  }

  return { versionsByEntry, versionContentById, versionEntryById }
}

const { versionsByEntry, versionContentById, versionEntryById } = buildLookupMaps()

export { versionsByEntry, versionContentById, versionEntryById }

export function listVersionsForEntry(entryId: string): VersionMeta[] {
  return versionsByEntry[entryId] ?? []
}

export function getVersionContentForEntry(versionId: string, entryId: string): number[] | null {
  if (versionEntryById[versionId] !== entryId) return null
  return versionContentById[versionId] ?? null
}
