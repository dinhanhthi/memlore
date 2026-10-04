import type { Entry, EmotionKey } from '../../src/types/entry'
import {
  JOURNAL_DAILY_ID,
  JOURNAL_WORK_ID,
  JOURNAL_TRAVEL_ID,
  JOURNAL_PRIVATE_ID,
} from './journals'

// Epoch-second helpers
function daysAgo(n: number): number {
  return Math.floor(Date.now() / 1000) - n * 24 * 60 * 60
}

function makeEntry(
  id: string,
  journalId: string,
  title: string | null,
  previewText: string | null,
  contentText: string | null,
  entryDate: number,
  emotion: EmotionKey | null,
  isFavorite: boolean,
  locationLabel: string | null = null,
  latitude: number | null = null,
  longitude: number | null = null,
  isLocked = false,
  isInvisible = false,
  media?: { coverMediaId: string; mediaCount: number },
  fromChat = false,
): Entry {
  return {
    id,
    journal_id: journalId,
    title,
    preview_text: previewText,
    content_text: contentText,
    entry_date: entryDate,
    created_at: entryDate,
    updated_at: entryDate + 60,
    latitude,
    longitude,
    location_label: locationLabel,
    location_address: locationLabel ? `${locationLabel}, Earth` : null,
    weather_summary: null,
    weather_icon: null,
    emotion,
    is_favorite: isFavorite,
    is_deleted: false,
    is_locked: isLocked,
    is_invisible: isInvisible,
    vault_id: null,
    cover_media_id: media?.coverMediaId ?? null,
    content_language: 'en',
    entry_date_user_edited: true,
    media_count: media?.mediaCount ?? 0,
    from_chat: fromChat,
  }
}

export const ENTRY_1_ID = 'entry-0001'
export const ENTRY_21_ID = 'entry-0021'
export const ENTRY_22_ID = 'entry-0022'
export const ENTRY_23_ID = 'entry-0023'
export const ENTRY_2_ID = 'entry-0002'
export const ENTRY_3_ID = 'entry-0003'
export const ENTRY_4_ID = 'entry-0004'
export const ENTRY_5_ID = 'entry-0005'
export const ENTRY_6_ID = 'entry-0006'
export const ENTRY_7_ID = 'entry-0007'
export const ENTRY_8_ID = 'entry-0008'
export const ENTRY_9_ID = 'entry-0009'
export const ENTRY_10_ID = 'entry-0010'
export const ENTRY_11_ID = 'entry-0011'
export const ENTRY_12_ID = 'entry-0012'
export const ENTRY_13_ID = 'entry-0013'
export const ENTRY_14_ID = 'entry-0014'
export const ENTRY_15_ID = 'entry-0015'
export const ENTRY_16_ID = 'entry-0016'
export const ENTRY_17_ID = 'entry-0017'
export const ENTRY_18_ID = 'entry-0018'
export const ENTRY_19_ID = 'entry-0019'
export const ENTRY_20_ID = 'entry-0020'
export const ENTRY_24_ID = 'entry-0024'
export const ENTRY_25_ID = 'entry-0025'
export const ENTRY_26_ID = 'entry-0026'
export const ENTRY_27_ID = 'entry-0027'
export const ENTRY_28_ID = 'entry-0028'
export const ENTRY_29_ID = 'entry-0029'
export const ENTRY_30_ID = 'entry-0030'
export const ENTRY_31_ID = 'entry-0031'
export const ENTRY_32_ID = 'entry-0032'
export const ENTRY_33_ID = 'entry-0033'
export const ENTRY_34_ID = 'entry-0034'
export const ENTRY_35_ID = 'entry-0035'
export const ENTRY_36_ID = 'entry-0036'
export const ENTRY_37_ID = 'entry-0037'
export const ENTRY_38_ID = 'entry-0038'

/** Long-form body for scroll testing in the web preview editor. */
export const FRESH_START_PARAGRAPHS = [
  'Woke up early and felt genuinely optimistic about the week ahead. Made coffee and sat on the balcony watching the sunrise. The light came in sideways, golden and warm, and I remembered why mornings matter.',
  'I have been thinking about what a fresh start actually means. It is not erasing the past or pretending yesterday did not happen. It is choosing, again, to meet the day with intention instead of inertia.',
  'The apartment was quiet. A kettle clicked off in the kitchen. Somewhere down the street a bicycle bell rang twice, then faded. Small sounds felt like invitations rather than interruptions.',
  'I opened the journal app before checking messages. That has become a fragile habit — easy to break on stressful mornings, surprisingly durable on calm ones. Today was calm.',
  'Last month I wrote that I wanted to write longer entries. This one is deliberately long so I can scroll through the editor and confirm the layout still breathes when content runs for pages.',
  'Paragraph by paragraph, the cursor should stay usable. The title should remain visible or sensibly pinned. The toolbar should not jump. These are the boring details that make software feel trustworthy.',
  'I made a list in my head of things I am grateful for: hot water, a roof, friends who reply, a body that still likes walking, work that challenges me without consuming me entirely.',
  'Gratitude lists can feel performative when you are low. Today they felt factual. Like inventory. Like proof that the ledger is not empty even when mood says otherwise.',
  'After coffee I stretched for ten minutes. Not a workout — just reaching, breathing, noticing where shoulders hold tension like they are guarding a door no one is trying to open.',
  'The sky turned from apricot to pale blue. Clouds were thin and high, brushstrokes rather than blankets. I thought about painting again, then remembered I do not need another hobby. Writing is enough.',
  'At nine I answered email. Most of it was coordination, not creation. I tried to batch it instead of letting it fracture the morning. One block, forty minutes, then closed the tab.',
  'A colleague sent a kind note about a doc I wrote last week. I read it twice, which is embarrassing and human. Praise evaporates faster than criticism in memory. I want to archive this one.',
  'Lunch was leftovers: rice, greens, something spicy. I ate at the table instead of the desk. The difference is small and total. Screens make every meal taste like hurry.',
  'In the afternoon I walked to the river without headphones. I wanted to hear the city: tram squeal, a child negotiating with a parent, wind in plane trees. My thoughts slowed to the pace of footsteps.',
  'An old man was feeding pigeons and scolding them affectionately, as if they were nephews. I smiled at him and he nodded like we had agreed on a secret about patience.',
  'I sat on a bench and reread a paragraph from a novel I have carried in my bag for three weeks. The same paragraph. Sometimes repetition is not failure; it is digestion.',
  'Back home I watered the plants. The monstera has a new leaf unfurling, still furled like a green scroll. Growth is often visible only if you look at the edges.',
  'I drafted an outline for a project I have been avoiding. Not finished — outlined. The empty page is less frightening once it has headings. Structure is a kindness to future-me.',
  'Dinner was simple pasta with lemon and pepper. I cooked while talking to my sister on speakerphone. She is renovating a bathroom and needed a witness to her frustration. I volunteered gladly.',
  'We laughed about how adulthood is just a series of invoices and small leaks. She asked if I am sleeping better. I said mostly yes. It was true enough to say aloud.',
  'After we hung up I cleaned the kitchen slowly, which is meditative if you pretend it is. Warm water, ceramic clink, the smell of soap. Order restored in one room at least.',
  'I read thirty pages of a history book about ports and trade routes. Niche, peaceful, full of maps. Maps calm me because they imply that getting lost is temporary.',
  'Before bed I returned to this entry and kept writing. The point is not brilliance. The point is length, flow, and the feeling of thoughts unspooling without hitting an artificial floor.',
  'If you are reading this in a preview build, scroll until your thumb tires. The editor should not jitter. The selection highlight should remain aligned. The word count should update without drama.',
  'Line after line, the document should behave like paper that never runs out, not like a text box pretending to be infinite until it breaks.',
  'I imagine future entries will be shorter again. That is fine. Today I needed room — room to think, room to test, room to notice that optimism is not loud. It is steady.',
  'Tomorrow I might run early, or I might sleep in and call it recovery. Both are allowed in a life that is not optimized for metrics. The journal is where I practice that permission.',
  'Midnight is near. The balcony door is open a finger-width. Cool air slips in like a polite guest. I will close it soon and set the alarm, not as a threat but as a promise.',
  'A fresh start, then, is not one morning. It is the accumulation of mornings where you show up, even when the entry is ordinary, even when the scroll bar is the most dramatic thing in the room.',
  'One more paragraph for good measure. And another after that. Long enough that the eye must travel. Long enough that the heart unclenches somewhere in the middle and forgets to keep counting.',
  'Still scrolling? Good. That means the fixture is doing its job. Real entries will not always be this long, but the app should welcome them when they are.',
  'I end where I began: with light, with warmth, with the sense that the week ahead is not a test I can fail, only a path I can walk. Goodnight, future reader. Goodnight, me.',
]

export const FRESH_START_CONTENT = FRESH_START_PARAGRAPHS.join('\n\n')
export const FRESH_START_PREVIEW =
  'Woke up early and felt genuinely optimistic about the week ahead. Made coffee and sat on the balcony watching the sunrise.'

/** Deliberately oversized body (~17 KB) — big enough on its own to cross
 *  `CHAT_RAG_WARN_BYTES` (16 KB, see `src-tauri/src/commands/ai.rs`), so
 *  attaching this single entry in the Daily Chat picker demos the "needs
 *  confirmation" size-readout treatment, not just the calm one every other
 *  (short) entry fixture produces. */
export const LONG_SESSION_CONTENT = [
  ...FRESH_START_PARAGRAPHS,
  ...FRESH_START_PARAGRAPHS,
  ...FRESH_START_PARAGRAPHS,
].join('\n\n')

export const entries: Entry[] = [
  makeEntry(
    ENTRY_1_ID,
    JOURNAL_DAILY_ID,
    'A fresh start',
    FRESH_START_PREVIEW,
    FRESH_START_CONTENT,
    daysAgo(0),
    'good',
    true,
    undefined,
    undefined,
    undefined,
    false,
    false,
    { coverMediaId: 'media-morning-005', mediaCount: 1 },
  ),
  makeEntry(
    ENTRY_2_ID,
    JOURNAL_DAILY_ID,
    'Productive afternoon',
    'Got through my entire task list before lunch. Treated myself to a long walk in the park afterwards.',
    'Got through my entire task list before lunch. Treated myself to a long walk in the park afterwards. The weather was perfect.',
    daysAgo(1),
    'good',
    false,
    'Parc des Buttes-Chaumont',
    48.8796,
    2.3834,
    false,
    false,
    { coverMediaId: 'media-cafe-006', mediaCount: 1 },
  ),
  makeEntry(
    ENTRY_3_ID,
    JOURNAL_DAILY_ID,
    'Quiet evening',
    'Not much to report — cooked dinner, read for an hour, early to bed. Sometimes ordinary is exactly right.',
    'Not much to report — cooked dinner, read for an hour, early to bed. Sometimes ordinary is exactly right.',
    daysAgo(2),
    'neutral',
    true, // isFavorite (also invisible locked)
    null, // locationLabel
    null, // lat
    null, // lon
    false, // isLocked
    true, // isInvisible
    { coverMediaId: 'media-sunset-007', mediaCount: 2 },
  ),
  makeEntry(
    ENTRY_4_ID,
    JOURNAL_WORK_ID,
    'Sprint planning done',
    'Wrapped up sprint planning. Team aligned on priorities. Feeling confident about this cycle.',
    'Wrapped up sprint planning. Team aligned on priorities. Feeling confident about this cycle. Three epics, eight stories, clear owners.',
    daysAgo(3),
    'good',
    true,
    undefined,
    undefined,
    undefined,
    false,
    false,
    { coverMediaId: 'media-park-009', mediaCount: 1 },
  ),
  makeEntry(
    ENTRY_5_ID,
    JOURNAL_DAILY_ID,
    null,
    'Rough morning. Alarm did not go off and I missed my standup. Coffee spilled on the keyboard.',
    'Rough morning. Alarm did not go off and I missed my standup. Coffee spilled on the keyboard. Could only go up from here.',
    daysAgo(4),
    'bad',
    false,
    undefined,
    undefined,
    undefined,
    false,
    false,
    { coverMediaId: 'media-market-010', mediaCount: 1 },
  ),
  makeEntry(
    ENTRY_6_ID,
    JOURNAL_TRAVEL_ID,
    'Arrived in Lisbon',
    'Landing was smooth. The city smells of grilled sardines and warm cobblestones. First impression: love it.',
    'Landing was smooth. The city smells of grilled sardines and warm cobblestones. First impression: love it. Checked into the guesthouse in Alfama.',
    daysAgo(5),
    'good',
    true,
    'Alfama, Lisbon',
    38.7139,
    -9.1334,
    false,
    false,
    { coverMediaId: 'media-lisbon-001', mediaCount: 4 },
  ),
  makeEntry(
    ENTRY_7_ID,
    JOURNAL_WORK_ID,
    'Design review',
    'The new onboarding flow got approved. Minor tweaks to the colour palette but the structure is solid.',
    'The new onboarding flow got approved. Minor tweaks to the colour palette but the structure is solid.',
    daysAgo(6),
    'neutral',
    false,
    null, // locationLabel
    null, // lat
    null, // lon
    false, // isLocked
    true, // isInvisible
    { coverMediaId: 'media-trail-011', mediaCount: 2 },
  ),
  makeEntry(
    ENTRY_8_ID,
    JOURNAL_DAILY_ID,
    'Rainy Saturday',
    'Stayed in all day with a pot of tea and three chapters of a novel. Rain on the window glass is underrated.',
    'Stayed in all day with a pot of tea and three chapters of a novel. Rain on the window glass is underrated.',
    daysAgo(7),
    'good',
    false,
  ),
  makeEntry(
    ENTRY_9_ID,
    JOURNAL_TRAVEL_ID,
    'Sintra day trip',
    'Took the train to Sintra. The palaces on the hilltop were worth every euro and the steep climb.',
    'Took the train to Sintra. The palaces on the hilltop were worth every euro and the steep climb. Ate the best pastel de nata of my life at the station bakery.',
    daysAgo(9),
    'good',
    true,
    'Sintra, Portugal',
    38.7978,
    -9.3875,
    false,
    false,
    { coverMediaId: 'media-sintra-002', mediaCount: 3 },
  ),
  makeEntry(
    ENTRY_10_ID,
    JOURNAL_WORK_ID,
    'Bug marathon',
    'Three hours tracking down a race condition in the sync engine. Fixed in two lines. Classic.',
    'Three hours tracking down a race condition in the sync engine. Fixed in two lines. Classic. Will write a regression test tomorrow.',
    daysAgo(10),
    'neutral',
    false,
    undefined,
    undefined,
    undefined,
    false,
    false,
    { coverMediaId: 'media-beach-013', mediaCount: 1 },
  ),
  makeEntry(
    ENTRY_11_ID,
    JOURNAL_DAILY_ID,
    'Journaling habit check-in',
    '50 consecutive days of journaling. Not every entry is profound, but the habit itself feels good.',
    '50 consecutive days of journaling. Not every entry is profound, but the habit itself feels good. Looking forward to 100.',
    daysAgo(14),
    'good',
    true,
    undefined,
    undefined,
    undefined,
    false,
    false,
    { coverMediaId: 'media-lake-014', mediaCount: 1 },
  ),
  makeEntry(
    ENTRY_12_ID,
    JOURNAL_DAILY_ID,
    null,
    'Wasted half the day doom-scrolling. Annoyed at myself. Going for a run tomorrow, no excuses.',
    'Wasted half the day doom-scrolling. Annoyed at myself. Going for a run tomorrow, no excuses.',
    daysAgo(15),
    'bad',
    true, // isFavorite (also second locked)
    null,
    null,
    null,
    true,
    false,
    { coverMediaId: 'media-garden-015', mediaCount: 1 },
    true, // fromChat — converted from a Daily Chat session
  ),
  makeEntry(
    ENTRY_13_ID,
    JOURNAL_WORK_ID,
    'Retrospective',
    'Good retro today. Team flagged the estimation drift and we agreed on a new pointing rubric.',
    'Good retro today. Team flagged the estimation drift and we agreed on a new pointing rubric. Action items assigned, not just noted.',
    daysAgo(18),
    'neutral',
    false,
    undefined,
    undefined,
    undefined,
    false,
    false,
    { coverMediaId: 'media-roof-016', mediaCount: 1 },
  ),
  makeEntry(
    ENTRY_14_ID,
    JOURNAL_DAILY_ID,
    'Dinner with old friends',
    'Saw Marie and Theo for the first time in two years. We closed the restaurant. Time collapses when you see people you love.',
    'Saw Marie and Theo for the first time in two years. We closed the restaurant. Time collapses when you see people you love.',
    daysAgo(20),
    'good',
    true,
    undefined,
    undefined,
    undefined,
    false,
    false,
    { coverMediaId: 'media-dinner-017', mediaCount: 1 },
  ),
  makeEntry(
    ENTRY_15_ID,
    JOURNAL_TRAVEL_ID,
    'Flight delayed',
    'Four-hour delay at the gate. No explanation, no updates. Wrote three entries in my phone to pass the time.',
    'Four-hour delay at the gate. No explanation, no updates. Wrote three entries in my phone to pass the time.',
    daysAgo(22),
    'bad',
    false,
    'CDG Airport, Paris',
    49.0097,
    2.5479,
  ),
  makeEntry(
    ENTRY_16_ID,
    JOURNAL_DAILY_ID,
    'Meditation streak: 7 days',
    'A week of morning meditation. Still only 10 minutes but I can feel the difference in how I handle interruptions.',
    'A week of morning meditation. Still only 10 minutes but I can feel the difference in how I handle interruptions.',
    daysAgo(28),
    'good',
    false,
  ),
  makeEntry(
    ENTRY_17_ID,
    JOURNAL_WORK_ID,
    'Onboarding new hire',
    'Spent the morning pairing with our new backend engineer. Lots of questions, which is a good sign. Sharp mind.',
    'Spent the morning pairing with our new backend engineer. Lots of questions, which is a good sign. Sharp mind.',
    daysAgo(32),
    'good',
    false,
  ),
  makeEntry(
    ENTRY_18_ID,
    JOURNAL_DAILY_ID,
    null,
    'Could not sleep. Lay awake thinking about nothing useful. Eventually gave up and made chamomile tea at 3 am.',
    'Could not sleep. Lay awake thinking about nothing useful. Eventually gave up and made chamomile tea at 3 am.',
    daysAgo(40),
    'bad',
    false,
    null,
    null,
    null,
    true,
    undefined,
    undefined,
    true, // fromChat — converted from a Daily Chat session
  ),
  makeEntry(
    ENTRY_19_ID,
    JOURNAL_TRAVEL_ID,
    'Porto: day one',
    'Arrived by bus from Lisbon. Immediate love for the azulejos and the Douro bridge at dusk.',
    'Arrived by bus from Lisbon. Immediate love for the azulejos and the Douro bridge at dusk. A perfect city to get lost in.',
    daysAgo(55),
    'good',
    true,
    'Ribeira, Porto',
    41.1413,
    -8.6148,
    false,
    false,
    { coverMediaId: 'media-porto-003', mediaCount: 2 },
  ),
  makeEntry(
    ENTRY_20_ID,
    JOURNAL_DAILY_ID,
    'Year-end reflection',
    'Looking back at the last 90 days of journaling. More highs than lows. Grateful for the practice.',
    'Looking back at the last 90 days of journaling. More highs than lows. Grateful for the practice. Next goal: write longer entries.',
    daysAgo(60),
    'good',
    false,
  ),
  makeEntry(
    ENTRY_21_ID,
    JOURNAL_PRIVATE_ID,
    'Therapy session notes',
    'We talked about the recurring anxiety around performance reviews. Dr. Mayer suggested a journaling exercise.',
    'We talked about the recurring anxiety around performance reviews. Dr. Mayer suggested a journaling exercise to separate facts from catastrophic thinking. Homework: write down three concrete things that went well each week.',
    daysAgo(3),
    'neutral',
    true, // isFavorite (also second locked, private journal)
    null,
    null,
    null,
    true,
  ),
  makeEntry(
    ENTRY_22_ID,
    JOURNAL_PRIVATE_ID,
    'Hard conversation with mum',
    'Finally told her how the last few years have made me feel. She cried. I cried. I think it needed to happen.',
    'Finally told her how the last few years have made me feel. She cried. I cried. I think it needed to happen. Not sure where we go from here but something shifted.',
    daysAgo(11),
    'bad',
    false,
    null,
    null,
    null,
    true,
  ),
  makeEntry(
    ENTRY_23_ID,
    JOURNAL_WORK_ID,
    'Unabridged project retrospective',
    'A much longer write-up than usual — wanted to get everything down before it faded.',
    LONG_SESSION_CONTENT,
    daysAgo(0),
    'good',
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    true, // fromChat — converted from a Daily Chat session
  ),
  // ── Same-day cluster (today): 6 entries across 3 journals ───────────────
  // ENTRY_1 (Daily) and ENTRY_23 (Work) already land on daysAgo(0); the four
  // below round today out to 3×Daily, 2×Work, 1×Travel so the Calendar
  // "selected day" list demos a multi-entry, multi-journal view.
  makeEntry(
    ENTRY_24_ID,
    JOURNAL_DAILY_ID,
    'Morning run along the river',
    'Five kilometres before breakfast. Legs heavy at first, then found a rhythm. The city is different at dawn.',
    'Five kilometres before breakfast. Legs heavy at first, then found a rhythm. The city is different at dawn — empty paths, delivery vans, the smell of bread from the bakery on the corner.',
    daysAgo(0),
    'good',
    false,
    'Seine riverside, Paris',
    48.8566,
    2.3522,
  ),
  makeEntry(
    ENTRY_25_ID,
    JOURNAL_DAILY_ID,
    'Lunch break notes',
    'Ate outside because the weather was too nice to sit at the desk. Jotted down three ideas for the weekend project.',
    'Ate outside because the weather was too nice to sit at the desk. Jotted down three ideas for the weekend project. None of them are urgent, which is exactly why they matter.',
    daysAgo(0),
    'neutral',
    false,
  ),
  makeEntry(
    ENTRY_26_ID,
    JOURNAL_WORK_ID,
    'Pair programming session',
    'Two hours with Sara on the auth refactor. We caught a boundary case neither of us would have spotted alone.',
    'Two hours with Sara on the auth refactor. We caught a boundary case neither of us would have spotted alone. Driver-navigator still works.',
    daysAgo(0),
    'good',
    false,
  ),
  makeEntry(
    ENTRY_27_ID,
    JOURNAL_TRAVEL_ID,
    'Sunset over the Tagus',
    'Ended the day at Miradouro da Senhora do Monte. The whole city turned copper, then violet. Worth the climb.',
    'Ended the day at Miradouro da Senhora do Monte. The whole city turned copper, then violet. Worth the climb. Stayed until the streetlights came on.',
    daysAgo(0),
    'good',
    true,
    'Senhora do Monte, Lisbon',
    38.7214,
    -9.1343,
  ),
  // ── Extra favorites for pagination testing — pushes the favorites count
  // past PAGE_SIZE so the Starred filter demos a second page.
  makeEntry(
    ENTRY_28_ID,
    JOURNAL_DAILY_ID,
    'Found my old journal from school',
    'Dug through a box in the closet and found a diary from ten years ago. Handwriting was terrible, feelings were not.',
    'Dug through a box in the closet and found a diary from ten years ago. Handwriting was terrible, feelings were not. Strange to see how much worry turned out to be nothing.',
    daysAgo(8),
    'good',
    true,
  ),
  makeEntry(
    ENTRY_29_ID,
    JOURNAL_WORK_ID,
    'Shipped the migration',
    'Three weeks of careful work and the cutover happened without a single page. Team deserves the rest of the week off.',
    'Three weeks of careful work and the cutover happened without a single page. Team deserves the rest of the week off. Wrote the postmortem while it was still fresh.',
    daysAgo(12),
    'good',
    true,
  ),
  makeEntry(
    ENTRY_30_ID,
    JOURNAL_TRAVEL_ID,
    'Ferry to the islands',
    'Two hours on open water, dolphins twice. Phone stayed in the bag the whole crossing.',
    'Two hours on open water, dolphins twice. Phone stayed in the bag the whole crossing. Arrived salty and grinning.',
    daysAgo(13),
    'good',
    true,
    'Aegean Sea',
    37.4,
    25.4,
  ),
  makeEntry(
    ENTRY_31_ID,
    JOURNAL_PRIVATE_ID,
    'The conversation I kept putting off',
    'Finally said the thing out loud. It landed better than I feared and worse than I hoped, which is probably honest.',
    'Finally said the thing out loud. It landed better than I feared and worse than I hoped, which is probably honest. Relief is a strange, heavy feeling.',
    daysAgo(16),
    'neutral',
    true,
    null,
    null,
    null,
    true,
  ),
  makeEntry(
    ENTRY_32_ID,
    JOURNAL_DAILY_ID,
    'First frost',
    'Woke up to a white lawn and had to scrape the windshield for the first time this year. Made the coffee taste better somehow.',
    'Woke up to a white lawn and had to scrape the windshield for the first time this year. Made the coffee taste better somehow. Winter announcing itself.',
    daysAgo(17),
    'good',
    true,
  ),
  makeEntry(
    ENTRY_33_ID,
    JOURNAL_WORK_ID,
    'Mentoring session with the new hire',
    'Spent an hour walking through the codebase together. She asked better questions than I did in my first month.',
    'Spent an hour walking through the codebase together. She asked better questions than I did in my first month. Good sign for the team.',
    daysAgo(19),
    'good',
    true,
  ),
  makeEntry(
    ENTRY_34_ID,
    JOURNAL_TRAVEL_ID,
    'Night train to the mountains',
    'Slept badly but woke up to a window full of peaks. Worth every hour of lost sleep.',
    'Slept badly but woke up to a window full of peaks. Worth every hour of lost sleep. Coffee from the dining car, watching the valley wake up.',
    daysAgo(21),
    'good',
    true,
    'Swiss Alps',
    46.8182,
    8.2275,
  ),
  makeEntry(
    ENTRY_35_ID,
    JOURNAL_DAILY_ID,
    'Sunday reset',
    'Laundry, groceries, meal prep, one long walk. Nothing remarkable and exactly what I needed before the week starts.',
    'Laundry, groceries, meal prep, one long walk. Nothing remarkable and exactly what I needed before the week starts.',
    daysAgo(25),
    'neutral',
    true,
  ),
  makeEntry(
    ENTRY_36_ID,
    JOURNAL_PRIVATE_ID,
    'Letter I will probably never send',
    'Wrote three pages to someone I have not spoken to in years. Not sure if it was for them or for me.',
    'Wrote three pages to someone I have not spoken to in years. Not sure if it was for them or for me. Folded it and put it in the drawer anyway.',
    daysAgo(35),
    'neutral',
    true,
    null,
    null,
    null,
    true,
  ),
  makeEntry(
    ENTRY_37_ID,
    JOURNAL_WORK_ID,
    'Promotion conversation',
    'My manager brought up the senior track today. Did not see it coming and now cannot stop thinking about it.',
    'My manager brought up the senior track today. Did not see it coming and now cannot stop thinking about it. Good problem to have.',
    daysAgo(45),
    'good',
    true,
  ),
  makeEntry(
    ENTRY_38_ID,
    JOURNAL_DAILY_ID,
    'Fixed the leaky faucet',
    'Finally got around to it after three months of a slow drip. Fifteen minutes and a new washer, that was it.',
    'Finally got around to it after three months of a slow drip. Fifteen minutes and a new washer, that was it. Should not have put it off so long.',
    daysAgo(50),
    'good',
    true,
  ),
]

/** Open-Meteo-shaped chips (`icon` + `"Desc, N°C"`) for the editor header. */
const PREVIEW_WEATHER: Record<string, { icon: string; summary: string }> = {
  [ENTRY_1_ID]: { icon: '☀️', summary: 'Clear sky, 22°C' },
  [ENTRY_2_ID]: { icon: '🌤️', summary: 'Mainly clear, 24°C' },
  [ENTRY_6_ID]: { icon: '☀️', summary: 'Clear sky, 28°C' },
  [ENTRY_8_ID]: { icon: '🌧️', summary: 'Rain, 14°C' },
  [ENTRY_9_ID]: { icon: '⛅', summary: 'Partly cloudy, 19°C' },
  [ENTRY_15_ID]: { icon: '⛈️', summary: 'Thunderstorm, 18°C' },
  [ENTRY_19_ID]: { icon: '🌦️', summary: 'Drizzle, 16°C' },
  [ENTRY_24_ID]: { icon: '🌤️', summary: 'Mainly clear, 15°C' },
  [ENTRY_25_ID]: { icon: '☀️', summary: 'Clear sky, 23°C' },
  [ENTRY_27_ID]: { icon: '☀️', summary: 'Clear sky, 26°C' },
  [ENTRY_30_ID]: { icon: '⛅', summary: 'Partly cloudy, 27°C' },
  [ENTRY_32_ID]: { icon: '🌫️', summary: 'Foggy, -1°C' },
  [ENTRY_34_ID]: { icon: '🌨️', summary: 'Snow, -4°C' },
}

for (const entry of entries) {
  const weather = PREVIEW_WEATHER[entry.id]
  if (!weather) continue
  entry.weather_icon = weather.icon
  entry.weather_summary = weather.summary
}
