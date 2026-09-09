import type { MemoryItemRow } from '../../src/lib/tauri'

const nowSec = Math.floor(Date.now() / 1000)
const DAY = 24 * 60 * 60

// ─── Memory item IDs ─────────────────────────────────────────────────────────
// Referenced by Daily Chat assistant rows via `memoryIds` (see chat.ts). Texts
// resolve live through `list_memory_items` — same path as the real app.

export const MEM_PRESENTATION_NERVES_ID = 'mem-presentation-nerves'
export const MEM_Q_AND_A_FEAR_ID = 'mem-q-and-a-fear'
export const MEM_PREPARE_THOROUGHLY_ID = 'mem-prepare-thoroughly'
export const MEM_SIDE_PROJECT_ID = 'mem-side-project'
export const MEM_EXERCISE_HABIT_ID = 'mem-exercise-habit'
export const MEM_SOCIAL_AVOIDANCE_ID = 'mem-social-avoidance'
export const MEM_DISTRIBUTED_SYSTEMS_ID = 'mem-distributed-systems'
export const MEM_CANCELLED_PROJECTS_ID = 'mem-cancelled-projects'
export const MEM_ELEGANT_CODE_PRIDE_ID = 'mem-elegant-code-pride'
export const MEM_SUNDAY_REVIEW_ID = 'mem-sunday-review'
export const MEM_CONTEXT_SWITCHING_ID = 'mem-context-switching'
export const MEM_DAD_RADIO_ID = 'mem-dad-radio'
export const MEM_DAD_SUNDAY_CALL_ID = 'mem-dad-sunday-call'
export const MEM_JAPAN_TRAVEL_ID = 'mem-japan-travel'
export const MEM_SOLO_TRAVEL_NERVES_ID = 'mem-solo-travel-nerves'
export const MEM_LIKES_HIKING_ID = 'mem-likes-hiking'
export const MEM_MORNING_TEA_ID = 'mem-morning-tea'
export const MEM_DA_NANG_ID = 'mem-da-nang'

function item(
  id: string,
  text: string,
  daysAgo: number,
  extra?: Partial<Pick<MemoryItemRow, 'sourceType' | 'enabled'>>,
): MemoryItemRow {
  const t = nowSec - daysAgo * DAY
  return {
    id,
    text,
    sourceType: extra?.sourceType ?? 'daily_chat',
    enabled: extra?.enabled ?? true,
    isDeleted: false,
    createdAt: t,
    updatedAt: t,
  }
}

/** Live (non-tombstoned) memory items for the web harness. Newest first to
 *  match `list_memory_items` ordering. Also seeds MemoriesSettings. */
export const memoryItems: MemoryItemRow[] = [
  item(
    MEM_CONTEXT_SWITCHING_ID,
    'Context switching drains energy more than long single-topic meetings.',
    2,
  ),
  item(MEM_SUNDAY_REVIEW_ID, 'Prefers Sunday evenings for a short weekly review ritual.', 5),
  item(MEM_PRESENTATION_NERVES_ID, 'Gets nervous before big work presentations.', 8),
  item(MEM_Q_AND_A_FEAR_ID, 'Finds open Q&A the hardest part of public speaking.', 8),
  item(
    MEM_PREPARE_THOROUGHLY_ID,
    'Copes with presentation nerves by preparing thoroughly in advance.',
    9,
  ),
  item(
    MEM_DISTRIBUTED_SYSTEMS_ID,
    'Proud of craft in distributed systems and data pipeline work.',
    12,
  ),
  item(
    MEM_ELEGANT_CODE_PRIDE_ID,
    'Takes pride in writing elegant code even when projects get cancelled.',
    12,
  ),
  item(
    MEM_CANCELLED_PROJECTS_ID,
    'Has experienced sudden project cancellations at work before.',
    14,
  ),
  item(MEM_SIDE_PROJECT_ID, 'Has a long-running side project they struggle to finish.', 18),
  item(
    MEM_EXERCISE_HABIT_ID,
    'Wants to exercise more consistently but drops the habit easily.',
    20,
  ),
  item(
    MEM_SOCIAL_AVOIDANCE_ID,
    'Uses social media scrolling as avoidance when hard work feels looming.',
    21,
  ),
  item(
    MEM_DAD_RADIO_ID,
    'Dad always had the garage radio slightly out of tune and never adjusted it.',
    22,
  ),
  item(
    MEM_DAD_SUNDAY_CALL_ID,
    'Dad called every Sunday at exactly 7pm — never early, never late.',
    22,
  ),
  item(
    MEM_JAPAN_TRAVEL_ID,
    'Dreams of a solo trip to Japan in spring (cherry blossom season).',
    30,
  ),
  item(
    MEM_SOLO_TRAVEL_NERVES_ID,
    'Nervous about navigating alone in a country where they do not speak the language.',
    30,
  ),
  item(MEM_LIKES_HIKING_ID, 'Likes hiking in the mountains on weekends.', 40, {
    sourceType: 'manual',
  }),
  item(MEM_MORNING_TEA_ID, 'Drinks green tea every morning before opening the laptop.', 45, {
    sourceType: 'manual',
  }),
  item(MEM_DA_NANG_ID, 'Keeps thinking about Đà Nẵng and wants to go back.', 50, {
    sourceType: 'manual',
  }),
]
