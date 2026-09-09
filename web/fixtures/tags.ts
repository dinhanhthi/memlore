import type { Tag } from '../../src/types/journal'

export const TAG_GRATITUDE_ID = 'tag-gratitude-001'
export const TAG_WORK_ID = 'tag-work-002'
export const TAG_TRAVEL_ID = 'tag-travel-003'
export const TAG_HEALTH_ID = 'tag-health-004'
export const TAG_REFLECTION_ID = 'tag-reflection-005'
export const TAG_FRIENDS_ID = 'tag-friends-006'
export const TAG_CODING_ID = 'tag-coding-007'
// A tag with no entries yet — renders dimmed (opacity-50) in the tag table.
export const TAG_IDEAS_ID = 'tag-ideas-008'

export const tags: Tag[] = [
  { id: TAG_GRATITUDE_ID, name: 'gratitude', color: '#F59E0B' },
  { id: TAG_WORK_ID, name: 'work', color: '#3B82F6' },
  { id: TAG_TRAVEL_ID, name: 'travel', color: '#10B981' },
  { id: TAG_HEALTH_ID, name: 'health', color: '#EF4444' },
  { id: TAG_REFLECTION_ID, name: 'self-reflection-and-daily-gratitude-notes', color: '#8B5CF6' },
  { id: TAG_FRIENDS_ID, name: 'friends', color: '#EC4899' },
  { id: TAG_CODING_ID, name: 'coding', color: '#06B6D4' },
  { id: TAG_IDEAS_ID, name: 'ideas', color: '#6366F1' },
]

// [Tag, count] tuples — shape expected by get_tags_with_counts
export const tagsWithCounts: Array<[Tag, number]> = [
  [tags[0], 8],
  [tags[1], 5],
  [tags[2], 4],
  [tags[3], 3],
  [tags[4], 6],
  [tags[5], 2],
  [tags[6], 3],
  [tags[7], 0],
]
