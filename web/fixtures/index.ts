import type { Entry, EmotionKey } from '../../src/types/entry'
import type { Tag } from '../../src/types/journal'

export {
  journals,
  JOURNAL_DAILY_ID,
  JOURNAL_WORK_ID,
  JOURNAL_TRAVEL_ID,
  JOURNAL_PRIVATE_ID,
} from './journals'
export {
  entries,
  ENTRY_1_ID,
  ENTRY_2_ID,
  ENTRY_3_ID,
  ENTRY_4_ID,
  ENTRY_5_ID,
  ENTRY_6_ID,
  ENTRY_7_ID,
  ENTRY_8_ID,
  ENTRY_9_ID,
  ENTRY_10_ID,
  ENTRY_11_ID,
  ENTRY_12_ID,
  ENTRY_13_ID,
  ENTRY_14_ID,
  ENTRY_15_ID,
  ENTRY_16_ID,
  ENTRY_17_ID,
  ENTRY_18_ID,
  ENTRY_19_ID,
  ENTRY_20_ID,
  ENTRY_21_ID,
  ENTRY_22_ID,
  ENTRY_23_ID,
} from './entries'
export { tags, tagsWithCounts } from './tags'
export { templates } from './templates'
export { entryContent } from './content'
export {
  versionsByEntry,
  versionContentById,
  listVersionsForEntry,
  getVersionContentForEntry,
} from './versions'
export {
  entriesOverTime,
  moodHistogram,
  moodTrend,
  tagFrequency,
  writingVolume,
  streakCalendar,
  locationDensity,
  streak,
} from './stats'
export {
  mediaRows,
  mediaByEntry,
  mapPins,
  makeMediaStatus,
  makeMediaStatusFor,
  coloredPngBytesFor,
  photoBytesFor,
  galleryMediaRows,
} from './media'
export { aiAuditRows, makeAiUsageSummary } from './ai'
export {
  chatSessions,
  chatSessionsById,
  makePagedChatSessions,
  CHAT_SESSION_1_ID,
  CHAT_SESSION_4_ID,
} from './chat'
export { memoryItems } from './memory'
export { makeConnectedDevices } from './devices'

// Re-import from submodules to build lookup maps
import { journals } from './journals'
import { entries } from './entries'
import { tags } from './tags'
import {
  TAG_GRATITUDE_ID,
  TAG_WORK_ID,
  TAG_TRAVEL_ID,
  TAG_HEALTH_ID,
  TAG_REFLECTION_ID,
  TAG_FRIENDS_ID,
  TAG_CODING_ID,
  TAG_IDEAS_ID,
} from './tags'
import {
  ENTRY_1_ID,
  ENTRY_4_ID,
  ENTRY_6_ID,
  ENTRY_8_ID,
  ENTRY_9_ID,
  ENTRY_11_ID,
  ENTRY_14_ID,
  ENTRY_17_ID,
} from './entries'

export const journalsById: Map<string, (typeof journals)[0]> = new Map(
  journals.map((j) => [j.id, j]),
)

export const entriesById: Map<string, Entry> = new Map(entries.map((e) => [e.id, e]))

export const entriesByJournal: Map<string, Entry[]> = new Map()
for (const entry of entries) {
  const existing = entriesByJournal.get(entry.journal_id) ?? []
  existing.push(entry)
  entriesByJournal.set(entry.journal_id, existing)
}

/** A few entries have explicit tag associations for the preview. */
const TAG_ASSOCIATIONS: Array<[string, Tag[]]> = [
  [
    ENTRY_1_ID,
    [tags.find((t) => t.id === TAG_GRATITUDE_ID)!, tags.find((t) => t.id === TAG_REFLECTION_ID)!],
  ],
  [
    ENTRY_4_ID,
    [tags.find((t) => t.id === TAG_WORK_ID)!, tags.find((t) => t.id === TAG_CODING_ID)!],
  ],
  // ENTRY_6 carries every tag EXCEPT `ideas`, which must stay at 0 entries.
  [ENTRY_6_ID, tags.filter((t) => t.id !== TAG_IDEAS_ID)],
  [ENTRY_8_ID, [tags.find((t) => t.id === TAG_HEALTH_ID)!]],
  [
    ENTRY_9_ID,
    [tags.find((t) => t.id === TAG_TRAVEL_ID)!, tags.find((t) => t.id === TAG_GRATITUDE_ID)!],
  ],
  [
    ENTRY_11_ID,
    [tags.find((t) => t.id === TAG_REFLECTION_ID)!, tags.find((t) => t.id === TAG_GRATITUDE_ID)!],
  ],
  [
    ENTRY_14_ID,
    [tags.find((t) => t.id === TAG_FRIENDS_ID)!, tags.find((t) => t.id === TAG_GRATITUDE_ID)!],
  ],
  [ENTRY_17_ID, [tags.find((t) => t.id === TAG_WORK_ID)!]],
]

export const tagsForEntry: Map<string, Tag[]> = new Map(TAG_ASSOCIATIONS)

/** date string (YYYY-MM-DD) → emotion for tagged entries. */
export const emotionByDate: Map<string, EmotionKey> = new Map(
  entries
    .filter((e) => e.emotion !== null)
    .map((e) => {
      const d = new Date(e.entry_date * 1000)
      const dateStr = d.toISOString().slice(0, 10)
      return [dateStr, e.emotion as EmotionKey]
    }),
)
