import type { ChatSession, ChatSessionMeta } from '../../src/types/ai'
import type { PagedResult } from '../../src/types/pagination'
import {
  ENTRY_1_ID,
  ENTRY_2_ID,
  ENTRY_4_ID,
  ENTRY_6_ID,
  ENTRY_8_ID,
  ENTRY_9_ID,
  ENTRY_10_ID,
  ENTRY_11_ID,
  ENTRY_13_ID,
  ENTRY_14_ID,
  ENTRY_16_ID,
  ENTRY_17_ID,
} from './entries'
import {
  MEM_CANCELLED_PROJECTS_ID,
  MEM_CONTEXT_SWITCHING_ID,
  MEM_DAD_RADIO_ID,
  MEM_DAD_SUNDAY_CALL_ID,
  MEM_DISTRIBUTED_SYSTEMS_ID,
  MEM_ELEGANT_CODE_PRIDE_ID,
  MEM_EXERCISE_HABIT_ID,
  MEM_JAPAN_TRAVEL_ID,
  MEM_PREPARE_THOROUGHLY_ID,
  MEM_PRESENTATION_NERVES_ID,
  MEM_Q_AND_A_FEAR_ID,
  MEM_SIDE_PROJECT_ID,
  MEM_SOCIAL_AVOIDANCE_ID,
  MEM_SOLO_TRAVEL_NERVES_ID,
  MEM_SUNDAY_REVIEW_ID,
} from './memory'

const nowSec = Math.floor(Date.now() / 1000)
const MIN = 60
const HOUR = 60 * MIN
const DAY = 24 * HOUR

// ─── Session IDs ─────────────────────────────────────────────────────────────

export const CHAT_SESSION_1_ID = 'chat-session-001'
export const CHAT_SESSION_2_ID = 'chat-session-002'
export const CHAT_SESSION_3_ID = 'chat-session-003'
export const CHAT_SESSION_4_ID = 'chat-session-004'
export const CHAT_SESSION_5_ID = 'chat-session-005'
export const CHAT_SESSION_6_ID = 'chat-session-006'
export const CHAT_SESSION_7_ID = 'chat-session-007'
export const CHAT_SESSION_8_ID = 'chat-session-008'
export const CHAT_SESSION_9_ID = 'chat-session-009'
export const CHAT_SESSION_10_ID = 'chat-session-010'
export const CHAT_SESSION_11_ID = 'chat-session-011'
export const CHAT_SESSION_12_ID = 'chat-session-012'
export const CHAT_SESSION_13_ID = 'chat-session-013'
export const CHAT_SESSION_14_ID = 'chat-session-014'
export const CHAT_SESSION_15_ID = 'chat-session-015'
export const CHAT_SESSION_16_ID = 'chat-session-016'
export const CHAT_SESSION_17_ID = 'chat-session-017'
export const CHAT_SESSION_18_ID = 'chat-session-018'
export const CHAT_SESSION_19_ID = 'chat-session-019'
export const CHAT_SESSION_20_ID = 'chat-session-020'
export const CHAT_SESSION_21_ID = 'chat-session-021'
export const CHAT_SESSION_22_ID = 'chat-session-022'
export const CHAT_SESSION_23_ID = 'chat-session-023'

// ─── Session metadata (list view) ────────────────────────────────────────────

// Two of these are pinned. Note `pinnedAt === updatedAt` on both: the backend's
// `set_chat_session_pinned` stamps the same `now` into each, so any other shape
// would be unreachable in the real app. What makes the pin *visible* here is
// that unpinned sessions (session 1, 5 minutes old) have been updated since —
// that is the ordinary case of pinning a conversation and then chatting in
// others. Sorting lives in `makePagedChatSessions` below, not in this order.
//
// Sessions 8–23 are filler so the list overflows one page (pageSize = 10) and
// the paginator renders three pages — the preview needs that to exercise the
// page controls.
export const chatSessions: ChatSessionMeta[] = [
  {
    id: CHAT_SESSION_6_ID,
    title: 'Weekly review ritual',
    createdAt: nowSec - 40 * DAY,
    updatedAt: nowSec - 6 * HOUR,
    messageCount: 9,
    usedRag: true,
    convertedEntryId: ENTRY_6_ID,
    pinnedAt: nowSec - 6 * HOUR,
  },
  {
    id: CHAT_SESSION_7_ID,
    title: 'Things I want to remember about Dad',
    createdAt: nowSec - 22 * DAY,
    updatedAt: nowSec - 2 * DAY,
    messageCount: 5,
    usedRag: false,
    convertedEntryId: null,
    pinnedAt: nowSec - 2 * DAY,
  },
  {
    id: CHAT_SESSION_1_ID,
    title: 'Morning reflections',
    createdAt: nowSec - 2 * HOUR,
    updatedAt: nowSec - 5 * MIN,
    messageCount: 6,
    usedRag: true,
    convertedEntryId: null,
    pinnedAt: null,
  },
  {
    id: CHAT_SESSION_4_ID,
    title: null,
    createdAt: nowSec - 35 * MIN,
    updatedAt: nowSec - 30 * MIN,
    messageCount: 2,
    usedRag: false,
    convertedEntryId: null,
    pinnedAt: null,
  },
  {
    id: CHAT_SESSION_2_ID,
    title: 'Processing a difficult week',
    createdAt: nowSec - 3 * DAY - 1 * HOUR,
    updatedAt: nowSec - 3 * DAY,
    messageCount: 12,
    usedRag: true,
    convertedEntryId: ENTRY_2_ID,
    pinnedAt: null,
  },
  {
    id: CHAT_SESSION_3_ID,
    title: 'Goal-setting for the month',
    createdAt: nowSec - 8 * DAY - 2 * HOUR,
    updatedAt: nowSec - 8 * DAY,
    messageCount: 8,
    usedRag: false,
    convertedEntryId: null,
    pinnedAt: null,
  },
  {
    id: CHAT_SESSION_5_ID,
    title: 'Travel planning thoughts',
    createdAt: nowSec - 15 * DAY - 3 * HOUR,
    updatedAt: nowSec - 15 * DAY,
    messageCount: 16,
    usedRag: false,
    convertedEntryId: null,
    pinnedAt: null,
  },
  {
    id: CHAT_SESSION_8_ID,
    title: 'Reading list catch-up',
    createdAt: nowSec - 16 * DAY - 2 * HOUR,
    updatedAt: nowSec - 16 * DAY,
    messageCount: 4,
    usedRag: true,
    convertedEntryId: null,
    pinnedAt: null,
  },
  {
    id: CHAT_SESSION_9_ID,
    title: 'Garden plans for the balcony',
    createdAt: nowSec - 17 * DAY,
    updatedAt: nowSec - 17 * DAY + 20 * MIN,
    messageCount: 3,
    usedRag: false,
    convertedEntryId: null,
    pinnedAt: null,
  },
  {
    id: CHAT_SESSION_10_ID,
    title: null,
    createdAt: nowSec - 18 * DAY - 4 * HOUR,
    updatedAt: nowSec - 18 * DAY - 3 * HOUR,
    messageCount: 1,
    usedRag: false,
    convertedEntryId: null,
    pinnedAt: null,
  },
  {
    id: CHAT_SESSION_11_ID,
    title: 'Budget review for the quarter',
    createdAt: nowSec - 19 * DAY - 1 * HOUR,
    updatedAt: nowSec - 19 * DAY,
    messageCount: 7,
    usedRag: true,
    convertedEntryId: null,
    pinnedAt: null,
  },
  {
    id: CHAT_SESSION_12_ID,
    title: 'Learning Rust — where to next?',
    createdAt: nowSec - 20 * DAY - 6 * HOUR,
    updatedAt: nowSec - 20 * DAY,
    messageCount: 11,
    usedRag: true,
    convertedEntryId: null,
    pinnedAt: null,
  },
  {
    id: CHAT_SESSION_13_ID,
    title: 'Wedding planning notes',
    createdAt: nowSec - 21 * DAY - 2 * HOUR,
    updatedAt: nowSec - 21 * DAY,
    messageCount: 9,
    usedRag: false,
    convertedEntryId: null,
    pinnedAt: null,
  },
  {
    id: CHAT_SESSION_14_ID,
    title: 'Therapy session debrief',
    createdAt: nowSec - 22 * DAY - 5 * HOUR,
    updatedAt: nowSec - 22 * DAY - 4 * HOUR,
    messageCount: 5,
    usedRag: false,
    convertedEntryId: null,
    pinnedAt: null,
  },
  {
    id: CHAT_SESSION_15_ID,
    title: 'Rewriting my resume',
    createdAt: nowSec - 24 * DAY,
    updatedAt: nowSec - 23 * DAY,
    messageCount: 8,
    usedRag: true,
    convertedEntryId: null,
    pinnedAt: null,
  },
  {
    id: CHAT_SESSION_16_ID,
    title: null,
    createdAt: nowSec - 25 * DAY - 3 * HOUR,
    updatedAt: nowSec - 25 * DAY - 2 * HOUR,
    messageCount: 2,
    usedRag: false,
    convertedEntryId: null,
    pinnedAt: null,
  },
  {
    id: CHAT_SESSION_17_ID,
    title: 'Cooking journal — sourdough attempts',
    createdAt: nowSec - 27 * DAY,
    updatedAt: nowSec - 26 * DAY,
    messageCount: 6,
    usedRag: false,
    convertedEntryId: null,
    pinnedAt: null,
  },
  {
    id: CHAT_SESSION_18_ID,
    title: 'Moving apartment logistics',
    createdAt: nowSec - 29 * DAY - 1 * HOUR,
    updatedAt: nowSec - 28 * DAY,
    messageCount: 10,
    usedRag: false,
    convertedEntryId: null,
    pinnedAt: null,
  },
  {
    id: CHAT_SESSION_19_ID,
    title: 'Reflecting on a friendship that drifted',
    createdAt: nowSec - 31 * DAY,
    updatedAt: nowSec - 30 * DAY,
    messageCount: 4,
    usedRag: true,
    convertedEntryId: null,
    pinnedAt: null,
  },
  {
    id: CHAT_SESSION_20_ID,
    title: 'Side project architecture sketch',
    createdAt: nowSec - 34 * DAY - 2 * HOUR,
    updatedAt: nowSec - 33 * DAY,
    messageCount: 7,
    usedRag: true,
    convertedEntryId: null,
    pinnedAt: null,
  },
  {
    id: CHAT_SESSION_21_ID,
    title: 'New year intentions check-in',
    createdAt: nowSec - 40 * DAY,
    updatedAt: nowSec - 38 * DAY,
    messageCount: 5,
    usedRag: false,
    convertedEntryId: null,
    pinnedAt: null,
  },
  {
    id: CHAT_SESSION_22_ID,
    title: 'Doctors appointment prep',
    createdAt: nowSec - 42 * DAY - 4 * HOUR,
    updatedAt: nowSec - 42 * DAY,
    messageCount: 3,
    usedRag: false,
    convertedEntryId: null,
    pinnedAt: null,
  },
  {
    id: CHAT_SESSION_23_ID,
    title: 'Old book club discussion',
    createdAt: nowSec - 46 * DAY,
    updatedAt: nowSec - 45 * DAY,
    messageCount: 6,
    usedRag: false,
    convertedEntryId: null,
    pinnedAt: null,
  },
]

// ─── Full session data (loaded on demand) ─────────────────────────────────────

function msg(
  id: string,
  seq: number,
  role: ChatSession['messages'][0]['role'],
  content: string,
  createdAt: number,
  extra?: Pick<ChatSession['messages'][0], 'attachments' | 'sourceEntryIds' | 'memoryIds'>,
): ChatSession['messages'][0] {
  return { id, role, content, seq, createdAt, ...extra }
}

/** Compact filler session for pagination (sessions 8–23). Realistic enough to
 *  open in the preview but each kept to a single exchange — these exist to
 *  overflow the list past one page, not to exercise any per-session UI. */
function fillerSession(
  id: string,
  title: string | null,
  persona: ChatSession['persona'],
  updatedAt: number,
  openingUser: string,
  reply: string,
): ChatSession {
  return {
    id,
    title,
    persona,
    language: 'en',
    createdAt: updatedAt - 2 * MIN,
    updatedAt,
    convertedEntryId: null,
    convertedThroughSeq: null,
    messages: [
      msg(`${id}-m1`, 1, 'user', openingUser, updatedAt - 2 * MIN),
      msg(`${id}-m2`, 2, 'assistant', reply, updatedAt),
    ],
  }
}

const SESSION_1: ChatSession = {
  id: CHAT_SESSION_1_ID,
  title: 'Morning reflections',
  persona: 'empathetic',
  language: 'en',
  createdAt: nowSec - 2 * HOUR,
  updatedAt: nowSec - 5 * MIN,
  convertedEntryId: null,
  convertedThroughSeq: null,
  messages: [
    msg(
      's1-m1',
      1,
      'assistant',
      "Good morning! It's wonderful to start the day with a moment of reflection. How are you feeling right now, and what's on your mind as you begin today?",
      nowSec - 2 * HOUR,
    ),
    msg(
      's1-m2',
      2,
      'user',
      "I'm feeling pretty good overall, but there's a big presentation at work this afternoon and I can feel the nerves building up already.",
      nowSec - 110 * MIN,
      {
        attachments: [
          { kind: 'entry', id: ENTRY_4_ID },
          { kind: 'period', start: nowSec - 7 * DAY, end: nowSec, label: 'This week' },
        ],
      },
    ),
    msg(
      's1-m3',
      3,
      'assistant',
      "It makes complete sense to feel those nerves — a big presentation carries real weight, especially when you care about doing well. That tension you're feeling is actually your mind and body gearing up to perform. Can you tell me a bit more about the presentation? What part of it feels most uncertain right now?",
      nowSec - 108 * MIN,
      {
        sourceEntryIds: [ENTRY_4_ID, ENTRY_13_ID],
        memoryIds: [MEM_PRESENTATION_NERVES_ID, MEM_PREPARE_THOROUGHLY_ID],
      },
    ),
    msg(
      's1-m4',
      4,
      'user',
      'The Q&A at the end is what worries me most. I can prepare the slides perfectly but I can never predict what questions people will throw at me.',
      nowSec - 100 * MIN,
    ),
    msg(
      's1-m5',
      5,
      'assistant',
      "That's such a common and understandable fear — the Q&A feels like stepping off the script into the unknown. A few things that might help: First, you already know your material better than anyone in the room, so trust that foundation. Second, it's completely okay to say \"That's a great question — let me think about that for a moment\" before answering. Pausing shows thoughtfulness, not weakness. And if you truly don't know something, \"I'll look into that and follow up\" is an honest, professional answer. How does approaching it that way feel to you?",
      nowSec - 98 * MIN,
      { memoryIds: [MEM_Q_AND_A_FEAR_ID, MEM_PRESENTATION_NERVES_ID, MEM_PREPARE_THOROUGHLY_ID] },
    ),
    msg(
      's1-m6',
      6,
      'user',
      'That actually helps a lot. I think I put too much pressure on myself to have all the answers instantly. Thanks, I feel more settled now.',
      nowSec - 5 * MIN,
    ),
  ],
}

const SESSION_2: ChatSession = {
  id: CHAT_SESSION_2_ID,
  title: 'Processing a difficult week',
  persona: 'empathetic',
  language: 'en',
  createdAt: nowSec - 3 * DAY - 1 * HOUR,
  updatedAt: nowSec - 3 * DAY,
  convertedEntryId: ENTRY_2_ID,
  convertedThroughSeq: 12,
  messages: [
    msg(
      's2-m1',
      1,
      'assistant',
      "Welcome back. I'm here whenever you're ready to reflect. What's been happening in your world lately?",
      nowSec - 3 * DAY - 1 * HOUR,
    ),
    msg(
      's2-m2',
      2,
      'user',
      "Honestly, this week has been rough. A project I've been working on for three months just got cancelled out of nowhere by management.",
      nowSec - 3 * DAY - 58 * MIN,
    ),
    msg(
      's2-m3',
      3,
      'assistant',
      "Three months of your time, energy, and focus — and then just gone. That's a genuinely hard thing to process. It's not just the project itself; it's also what it means for all the effort you put in. How are you feeling about it — more frustrated, disappointed, or something else entirely?",
      nowSec - 3 * DAY - 56 * MIN,
    ),
    msg(
      's2-m4',
      4,
      'user',
      'All of the above, honestly. But mostly I feel like it was a waste. Like nothing I did mattered in the end.',
      nowSec - 3 * DAY - 50 * MIN,
    ),
    msg(
      's2-m5',
      5,
      'assistant',
      "I hear that feeling of \"what was the point?\" — and it's a painful place to sit. But I want to gently push back on one thing: the work wasn't wasted just because the project was cancelled. You spent three months developing skills, solving problems, and building knowledge that didn't disappear when the project did. What specifically were you working on? Sometimes naming the actual work makes it easier to see its real value.",
      nowSec - 3 * DAY - 48 * MIN,
    ),
    msg(
      's2-m6',
      6,
      'user',
      'It was a new data pipeline architecture. I learned a ton about distributed systems and wrote some really elegant code I was proud of.',
      nowSec - 3 * DAY - 40 * MIN,
    ),
    msg(
      's2-m7',
      7,
      'assistant',
      'There it is. That knowledge about distributed systems, that elegant code, the problem-solving you did — that\'s all yours now. Nobody can cancel that. Would it help to document what you built somewhere, even just for yourself? Sometimes making the work visible — writing it up in your journal, saving the code — turns "wasted effort" back into something concrete you created.',
      nowSec - 3 * DAY - 38 * MIN,
      {
        // Deliberately >10 ids — exercises the "Showing 10 of N" truncation
        // line in ChatSourceChips.
        sourceEntryIds: [
          ENTRY_1_ID,
          ENTRY_2_ID,
          ENTRY_4_ID,
          ENTRY_6_ID,
          ENTRY_8_ID,
          ENTRY_9_ID,
          ENTRY_10_ID,
          ENTRY_11_ID,
          ENTRY_13_ID,
          ENTRY_14_ID,
          ENTRY_16_ID,
          ENTRY_17_ID,
        ],
        // Several memories so the "N memories used" popover has a real list
        // (and enough height to exercise scroll if max-height is added).
        memoryIds: [
          MEM_DISTRIBUTED_SYSTEMS_ID,
          MEM_ELEGANT_CODE_PRIDE_ID,
          MEM_CANCELLED_PROJECTS_ID,
          MEM_SIDE_PROJECT_ID,
          MEM_EXERCISE_HABIT_ID,
          MEM_SOCIAL_AVOIDANCE_ID,
          MEM_CONTEXT_SWITCHING_ID,
          MEM_PREPARE_THOROUGHLY_ID,
        ],
      },
    ),
    msg(
      's2-m8',
      8,
      'user',
      'Yeah, I think I should write it up as a technical post or something. At least then it lives somewhere.',
      nowSec - 3 * DAY - 30 * MIN,
    ),
    msg(
      's2-m9',
      9,
      'assistant',
      "That's a meaningful idea. Writing it up does two things: it honors the effort you put in, and it potentially helps others who run into the same problems. It also gives the project a different kind of ending — one you're in control of. How are you feeling about the rest of the week now?",
      nowSec - 3 * DAY - 28 * MIN,
    ),
    msg(
      's2-m10',
      10,
      'user',
      'A bit better. Still frustrated at the decision, but less like the work was pointless.',
      nowSec - 3 * DAY - 20 * MIN,
    ),
    msg(
      's2-m11',
      11,
      'assistant',
      'That shift matters. The frustration at the decision makes complete sense — that\'s not something you need to let go of quickly. But separating "this decision was frustrating" from "my work was worthless" is an important distinction. Is there anything else from this week that\'s been weighing on you?',
      nowSec - 3 * DAY - 18 * MIN,
    ),
    msg(
      's2-m12',
      12,
      'user',
      'Not really. I think getting this out has helped. I might start writing up that technical post tonight.',
      nowSec - 3 * DAY,
    ),
  ],
}

const SESSION_3: ChatSession = {
  id: CHAT_SESSION_3_ID,
  title: 'Goal-setting for the month',
  persona: 'wise',
  language: 'en',
  createdAt: nowSec - 8 * DAY - 2 * HOUR,
  updatedAt: nowSec - 8 * DAY,
  convertedEntryId: null,
  convertedThroughSeq: null,
  messages: [
    msg(
      's3-m1',
      1,
      'assistant',
      'A new month approaches. Often this is a good time to step back and think about what you actually want — not what you think you should want. What comes to mind when you ask yourself: what would make this month feel meaningful?',
      nowSec - 8 * DAY - 2 * HOUR,
    ),
    msg(
      's3-m2',
      2,
      'user',
      'I want to actually finish my side project, exercise consistently, and spend less time on social media. But I say that every month and it never happens.',
      nowSec - 8 * DAY - 118 * MIN,
    ),
    msg(
      's3-m3',
      3,
      'assistant',
      'The pattern you\'re describing — recurring intentions that don\'t translate into action — usually points to a mismatch between the goal and the system. The goals themselves sound reasonable, but "finish my side project" and "exercise consistently" are outcomes, not behaviors. What would you have to do differently this week specifically to move toward each of them? Start smaller than you think necessary.',
      nowSec - 8 * DAY - 116 * MIN,
    ),
    msg(
      's3-m4',
      4,
      'user',
      'I guess for the project I need to actually open my laptop and work on it for at least 30 minutes a day. For exercise, even a 20-minute walk would be a start.',
      nowSec - 8 * DAY - 108 * MIN,
    ),
    msg(
      's3-m5',
      5,
      'assistant',
      "Now those are real commitments — specific, small enough to actually do, and not dependent on motivation to execute. The social media question is worth examining separately: is this about reducing something harmful, or are you using a screen as a proxy for something you're actually wanting — connection, entertainment, rest? The reason matters for what to replace it with.",
      nowSec - 8 * DAY - 106 * MIN,
      {
        memoryIds: [MEM_SIDE_PROJECT_ID, MEM_EXERCISE_HABIT_ID, MEM_SOCIAL_AVOIDANCE_ID],
      },
    ),
    msg(
      's3-m6',
      6,
      'user',
      "Honestly it's mostly avoidance. When I don't want to work on the project I end up scrolling instead.",
      nowSec - 8 * DAY - 95 * MIN,
    ),
    msg(
      's3-m7',
      7,
      'assistant',
      "That's a useful insight. If the scrolling is displacement for the project, reducing social media isn't really a separate goal — it's downstream of the project habit. When you open your laptop for that 30 minutes, the pull toward the phone will naturally decrease because you've given the avoidance urge somewhere to go. Would you be willing to commit to just the 30-minute project sessions for this first week and see what happens to the rest?",
      nowSec - 8 * DAY - 93 * MIN,
    ),
    msg(
      's3-m8',
      8,
      'user',
      "Yeah, that makes sense. Focus on the one thing and see if the others fall into place. I'll try that this week.",
      nowSec - 8 * DAY,
    ),
  ],
}

const SESSION_4: ChatSession = {
  id: CHAT_SESSION_4_ID,
  title: null,
  persona: 'empathetic',
  language: 'en',
  createdAt: nowSec - 35 * MIN,
  updatedAt: nowSec - 30 * MIN,
  convertedEntryId: null,
  convertedThroughSeq: null,
  messages: [
    msg(
      's4-m1',
      1,
      'assistant',
      "Hi there. I'm glad you opened this. There's no agenda here — just space for whatever's on your mind today. What's going on?",
      nowSec - 35 * MIN,
    ),
    msg('s4-m2', 2, 'user', 'I keep thinking about Đà Nẵng.', nowSec - 30 * MIN),
  ],
}

const SESSION_5: ChatSession = {
  id: CHAT_SESSION_5_ID,
  title: 'Travel planning thoughts',
  persona: 'jolly',
  language: 'en',
  createdAt: nowSec - 15 * DAY - 3 * HOUR,
  updatedAt: nowSec - 15 * DAY,
  convertedEntryId: null,
  convertedThroughSeq: null,
  messages: [
    msg(
      's5-m1',
      1,
      'assistant',
      "Oh, I love when journal time turns into adventure planning! What's the travel dream we're exploring today?",
      nowSec - 15 * DAY - 3 * HOUR,
    ),
    msg(
      's5-m2',
      2,
      'user',
      "I'm thinking about taking a solo trip to Japan in the spring. I've always wanted to go but I keep putting it off.",
      nowSec - 15 * DAY - 178 * MIN,
    ),
    msg(
      's5-m3',
      3,
      'assistant',
      "Japan in spring — oh, you've picked a spectacular time! Cherry blossom season typically runs late March through April depending on the region. What's been stopping you from booking it? Is it logistics, cost, the solo travel part, or just the classic \"I'll do it later\" that somehow never arrives?",
      nowSec - 15 * DAY - 176 * MIN,
    ),
    msg(
      's5-m4',
      4,
      'user',
      "Mostly the solo part. I've never traveled alone before and it feels intimidating to navigate a country where I don't speak the language.",
      nowSec - 15 * DAY - 165 * MIN,
    ),
    msg(
      's5-m5',
      5,
      'assistant',
      "Here's the thing about Japan for solo travelers — it's actually one of the BEST countries to start with! English signage is everywhere in tourist areas, Google Translate has a live camera mode that reads Japanese text in real time, and Japanese cities are famously safe and well-organized. The intimidating part often melts away once you're actually there and realize the infrastructure is designed for confused visitors. What part of Japan are you most drawn to?",
      nowSec - 15 * DAY - 163 * MIN,
      { memoryIds: [MEM_JAPAN_TRAVEL_ID, MEM_SOLO_TRAVEL_NERVES_ID] },
    ),
    msg(
      's5-m6',
      6,
      'user',
      "Tokyo for sure, and I'd love to see Kyoto for the temples. Maybe Osaka too for the food. Is two weeks enough?",
      nowSec - 15 * DAY - 150 * MIN,
    ),
    msg(
      's5-m7',
      7,
      'assistant',
      "Two weeks is a really solid amount for Tokyo-Kyoto-Osaka — it's actually the classic Golden Route, and for good reason. Rough split: 5-6 days Tokyo, day trip to Nikko or Hakone if you want nature, then Shinkansen to Kyoto for 4-5 days, and 2-3 days in Osaka before flying home. That leaves breathing room for getting lost (which, I promise, is the best part). Have you started looking at flights yet?",
      nowSec - 15 * DAY - 148 * MIN,
    ),
    msg(
      's5-m8',
      8,
      'user',
      'Not yet. I keep saying "I\'ll look next week" but I never do. How do I actually make myself commit?',
      nowSec - 15 * DAY - 135 * MIN,
    ),
    msg(
      's5-m9',
      9,
      'assistant',
      'Set a 20-minute flight search right now — not to book, just to look. Look at prices, look at dates, get a real number in your head. Future dreams stay dreams until they hit the reality of an actual flight time and an actual price. Once you know "it would cost about X to fly in late March," the decision gets concrete. You can always not book — but at least then you\'re choosing not to, rather than just drifting. Can you do the search today?',
      nowSec - 15 * DAY - 133 * MIN,
    ),
    msg(
      's5-m10',
      10,
      'user',
      'Yeah, I can do that after lunch. What about accommodation — hotel or hostel?',
      nowSec - 15 * DAY - 120 * MIN,
    ),
    msg(
      's5-m11',
      11,
      'assistant',
      "For first-time solo travel, I'd say a mix! Tokyo has amazing capsule hotels that are a uniquely Japanese experience and very affordable. Kyoto has lovely traditional ryokan guesthouses — splurge on one night in a ryokan with a multi-course kaiseki dinner, it's worth it. Osaka is great for budget stays near Dotonbori. The solo travel magic is that you make 100% of these decisions, which feels overwhelming before you start and incredibly freeing once you're doing it.",
      nowSec - 15 * DAY - 118 * MIN,
    ),
    msg(
      's5-m12',
      12,
      'user',
      "A ryokan sounds incredible. I hadn't thought about that. What should I know about Japanese travel etiquette so I don't embarrass myself?",
      nowSec - 15 * DAY - 105 * MIN,
    ),
    msg(
      's5-m13',
      13,
      'assistant',
      'You\'re already ahead just by asking! Big ones: shoes off when entering homes, traditional restaurants, and ryokan — look for a step up ("genkan") as the cue. Quiet on trains and subways, no phone calls. No tipping — ever, anywhere, it can be seen as rude. Two hands when giving or receiving something. Cash is still king in many places, especially outside Tokyo, so carry yen. And if you\'re unsure about something, a respectful "sumimasen" (excuse me) goes a long way. Japanese people are overwhelmingly kind to visitors who are clearly trying.',
      nowSec - 15 * DAY - 103 * MIN,
    ),
    msg(
      's5-m14',
      14,
      'user',
      "This is so helpful. I feel way more confident about this trip now. I'm going to look at flights today.",
      nowSec - 15 * DAY - 45 * MIN,
    ),
    msg(
      's5-m15',
      15,
      'assistant',
      "Yes! Go look at those flights! And write about it in your journal when you do — future-you reading about the moment you finally decided to stop putting it off is going to be a lovely entry. What's the rough budget you're working with for the whole trip?",
      nowSec - 15 * DAY - 43 * MIN,
    ),
    msg(
      's5-m16',
      16,
      'user',
      'Around $3000 all-in. Is that realistic for two weeks?',
      nowSec - 15 * DAY,
    ),
  ],
}

// A pinned session: long-running, returned to weekly, which is exactly the kind
// a user pins. `updatedAt` matches its `pinnedAt` in the meta above.
const SESSION_6: ChatSession = {
  id: CHAT_SESSION_6_ID,
  title: 'Weekly review ritual',
  persona: 'empathetic',
  language: 'en',
  createdAt: nowSec - 40 * DAY,
  updatedAt: nowSec - 6 * HOUR,
  convertedEntryId: ENTRY_6_ID,
  convertedThroughSeq: 9,
  messages: [
    msg(
      's6-m1',
      1,
      'user',
      'I want to start doing a weekly review. Can you help me build a routine I will actually stick to?',
      nowSec - 40 * DAY,
    ),
    msg(
      's6-m2',
      2,
      'assistant',
      "Let's keep it small enough that skipping it feels harder than doing it. Three questions, fifteen minutes, same slot every week: What did I actually do? What drained me? What is one thing I want to carry into next week? Which day feels least crowded for you?",
      nowSec - 40 * DAY + 3 * MIN,
    ),
    msg(
      's6-m3',
      3,
      'user',
      'Sunday evenings are quiet. Let me try that.',
      nowSec - 40 * DAY + 6 * MIN,
    ),
    msg(
      's6-m4',
      4,
      'user',
      'Week three. I missed last Sunday and felt guilty about it all Monday.',
      nowSec - 19 * DAY,
    ),
    msg(
      's6-m5',
      5,
      'assistant',
      'Missing one is data, not failure — the guilt is the part worth looking at. A ritual you dread skipping has already become an obligation. What if a missed week just rolls into the next one instead of needing to be made up?',
      nowSec - 19 * DAY + 2 * MIN,
    ),
    msg(
      's6-m6',
      6,
      'user',
      'That helps. I pinned this conversation so I can find it each week.',
      nowSec - 19 * DAY + 5 * MIN,
    ),
    msg(
      's6-m7',
      7,
      'user',
      'Sunday again. This week was mostly meetings and I have little to show for it.',
      nowSec - 6 * HOUR - 12 * MIN,
    ),
    msg(
      's6-m8',
      8,
      'assistant',
      "Looking back at your entries this week, two of those meetings ended with you writing that you'd finally unblocked someone else's work. That is something to show for it — it just doesn't leave a visible artifact of your own. What drained you most?",
      nowSec - 6 * HOUR - 9 * MIN,
      {
        sourceEntryIds: [ENTRY_2_ID, ENTRY_6_ID],
        memoryIds: [MEM_SUNDAY_REVIEW_ID, MEM_CONTEXT_SWITCHING_ID],
      },
    ),
    msg(
      's6-m9',
      9,
      'user',
      'Context switching. Six different topics in one day.',
      nowSec - 6 * HOUR,
    ),
  ],
}

// A second pinned session — kept for sentiment rather than reference, and
// deliberately not the most recently updated, so the list shows two pinned rows
// ordered by `pinnedAt` above fresher unpinned ones.
const SESSION_7: ChatSession = {
  id: CHAT_SESSION_7_ID,
  title: 'Things I want to remember about Dad',
  persona: 'empathetic',
  language: 'en',
  createdAt: nowSec - 22 * DAY,
  updatedAt: nowSec - 2 * DAY,
  convertedEntryId: null,
  convertedThroughSeq: null,
  messages: [
    msg(
      's7-m1',
      1,
      'user',
      'I keep meaning to write down the small things about my dad before I forget them. I never know where to start.',
      nowSec - 22 * DAY,
    ),
    msg(
      's7-m2',
      2,
      'assistant',
      'Start with a sound or a smell rather than a story — those tend to pull the rest along with them. What is the first one that comes to mind when you think of him?',
      nowSec - 22 * DAY + 4 * MIN,
      { memoryIds: [MEM_DAD_RADIO_ID] },
    ),
    msg(
      's7-m3',
      3,
      'user',
      'The radio in the garage. Always on, always slightly out of tune, and he never adjusted it.',
      nowSec - 22 * DAY + 9 * MIN,
    ),
    msg(
      's7-m4',
      4,
      'assistant',
      "That is a whole portrait in one detail — a man untroubled by static. Add one more whenever it surfaces; you don't need to finish this in one sitting.",
      nowSec - 22 * DAY + 11 * MIN,
      { memoryIds: [MEM_DAD_RADIO_ID, MEM_DAD_SUNDAY_CALL_ID] },
    ),
    msg(
      's7-m5',
      5,
      'user',
      'He called every Sunday at exactly 7pm. Never early, never late.',
      nowSec - 2 * DAY,
    ),
  ],
}

// ─── Filler sessions 8–23 (pagination overflow) ──────────────────────────────
// One exchange each; their metadata in `chatSessions` above is what the list
// paginates over, but `daily_chat_load_session` still needs a real session to
// open when a row is clicked.

const SESSION_8: ChatSession = fillerSession(
  CHAT_SESSION_8_ID,
  'Reading list catch-up',
  'wise',
  nowSec - 16 * DAY,
  'I have a stack of half-finished books. How do I decide what to finish vs. drop?',
  'Drop guilt as the filter — finish what is still pulling at you, set down what has gone quiet. Half-finished is data: those books gave you what they had in the first few chapters.',
)
const SESSION_9: ChatSession = fillerSession(
  CHAT_SESSION_9_ID,
  'Garden plans for the balcony',
  'jolly',
  nowSec - 17 * DAY + 20 * MIN,
  'My balcony gets maybe four hours of sun. What can I actually grow out there?',
  'Four hours is honest full-sun territory for herbs! Basil, mint (in its own pot, always), cherry tomatoes in a deep container, and a rosemary that will outlive us all. Start there.',
)
const SESSION_10: ChatSession = fillerSession(
  CHAT_SESSION_10_ID,
  null,
  'empathetic',
  nowSec - 18 * DAY - 3 * HOUR,
  'Just needed to say out loud that today felt heavy for no clear reason.',
  "Thank you for naming it. Heavy-for-no-clear-reason days are still real days, and giving them a sentence is enough. You don't need a reason to be gentle with yourself tonight.",
)
const SESSION_11: ChatSession = fillerSession(
  CHAT_SESSION_11_ID,
  'Budget review for the quarter',
  'wise',
  nowSec - 19 * DAY,
  'I overspent on eating out again. How do I make a budget I actually follow?',
  "Budgets fail when they're built on categories instead of behavior. Track one week honestly first — every coffee, every delivery — then cut the single biggest leak. One change at a time actually sticks.",
)
const SESSION_12: ChatSession = fillerSession(
  CHAT_SESSION_12_ID,
  'Learning Rust — where to next?',
  'wise',
  nowSec - 20 * DAY,
  "I've finished the book and can write small CLI tools. What's the next step that doesn't feel overwhelming?",
  "Pick a real, small program you actually want — something you'd otherwise write in a script — and port it. Ownership clicks when the compiler yells at you about code you care about, not toy examples.",
)
const SESSION_13: ChatSession = fillerSession(
  CHAT_SESSION_13_ID,
  'Wedding planning notes',
  'jolly',
  nowSec - 21 * DAY,
  'Guest list keeps growing and I am losing track of who said what. Help.',
  'Spreadsheet, three columns: name, plus-one status, RSVP. Update it the same day you hear back, not later — that is the entire trick. And remember: a shorter list is a calmer wedding.',
)
const SESSION_14: ChatSession = fillerSession(
  CHAT_SESSION_14_ID,
  'Therapy session debrief',
  'empathetic',
  nowSec - 22 * DAY - 4 * HOUR,
  'My therapist pointed out I apologize for everything, even things I want. I cannot stop hearing it now.',
  "That awareness is the work doing its job. Noticing in real time is the first crack — the pause before the next 'sorry' is where your choice lives. Be patient; you practiced that pattern for years.",
)
const SESSION_15: ChatSession = fillerSession(
  CHAT_SESSION_15_ID,
  'Rewriting my resume',
  'wise',
  nowSec - 23 * DAY,
  "I keep listing tasks instead of impact. How do I reframe without sounding like I'm bragging?",
  "Impact isn't bragging — it is what the work produced. For each bullet, ask 'so what?' and write the answer. 'Led migration' becomes 'Cut deploy time 40%, saving the team ~3 hours a week.' That is fact, not boast.",
)
const SESSION_16: ChatSession = fillerSession(
  CHAT_SESSION_16_ID,
  null,
  'empathetic',
  nowSec - 25 * DAY - 2 * HOUR,
  'Can a journal really just be one sentence? I never have energy for more.',
  'One sentence is a whole journal. The point is the returning, not the volume — a daily line you actually write beats a thoughtful essay you keep avoiding. Start that small on purpose.',
)
const SESSION_17: ChatSession = fillerSession(
  CHAT_SESSION_17_ID,
  'Cooking journal — sourdough attempts',
  'jolly',
  nowSec - 26 * DAY,
  'My third loaf came out flat and dense. Is my starter weak or my technique?',
  'Dense usually means under-fermented, not a weak starter! Try the float test on your starter first — if it floats, give the dough a longer bulk ferment next time. Bread teaches patience by refusing to be rushed.',
)
const SESSION_18: ChatSession = fillerSession(
  CHAT_SESSION_18_ID,
  'Moving apartment logistics',
  'wise',
  nowSec - 28 * DAY,
  'Moving in three weeks and I cannot think past the packing. Where do I even start?',
  'Start with what you will not need for three weeks: out-of-season clothes, books, decor. Box those this weekend. The rule is simple — pack anything you would not reach for before moving day.',
)
const SESSION_19: ChatSession = fillerSession(
  CHAT_SESSION_19_ID,
  'Reflecting on a friendship that drifted',
  'empathetic',
  nowSec - 30 * DAY,
  'A close friend and I just stopped talking. No fight, no reason. I keep replaying it.',
  'Drift is the quietest kind of loss — there is no moment to grieve, which makes it harder. Replaying it is your mind looking for a cause that often is not there. Would you want to reach out, or is naming the loss enough for now?',
)
const SESSION_20: ChatSession = fillerSession(
  CHAT_SESSION_20_ID,
  'Side project architecture sketch',
  'wise',
  nowSec - 33 * DAY,
  "I keep designing the 'perfect' architecture and never start coding. How do I break this?",
  'Perfect-first is procrastination wearing a flattering costume. Pick the smallest slice that could ship, build it ugly, and let the real architecture emerge from what you learn. You cannot architect what you have not yet built.',
)
const SESSION_21: ChatSession = fillerSession(
  CHAT_SESSION_21_ID,
  'New year intentions check-in',
  'empathetic',
  nowSec - 38 * DAY,
  "It is February and I've already dropped every January intention. Does that mean they were wrong?",
  'Not wrong — just started too big under January optimism. Dropping them this fast usually means they were built on willpower instead of systems. Pick the one that mattered most and shrink it until it is almost embarrassingly small.',
)
const SESSION_22: ChatSession = fillerSession(
  CHAT_SESSION_22_ID,
  'Doctors appointment prep',
  'wise',
  nowSec - 42 * DAY,
  'I always forget what I wanted to ask once I am in the room. How do I prep?',
  'Write your top three questions on your phone the moment you book the appointment, not the morning of. Bring it out before the doctor sits down. Three questions, written down, in your hand — that is the entire system.',
)
const SESSION_23: ChatSession = fillerSession(
  CHAT_SESSION_23_ID,
  'Old book club discussion',
  'jolly',
  nowSec - 45 * DAY,
  'Our book club picks keep falling flat. How do we choose books people actually read?',
  'Rotate the picker, one month each, and let the picker pick anything — even a re-read. Ownership beats consensus every time, and a passionate pick lands better than a safe one nobody is excited about.',
)

// ─── Lookup map ───────────────────────────────────────────────────────────────

export const chatSessionsById: Map<string, ChatSession> = new Map([
  [CHAT_SESSION_6_ID, SESSION_6],
  [CHAT_SESSION_7_ID, SESSION_7],
  [CHAT_SESSION_1_ID, SESSION_1],
  [CHAT_SESSION_2_ID, SESSION_2],
  [CHAT_SESSION_3_ID, SESSION_3],
  [CHAT_SESSION_4_ID, SESSION_4],
  [CHAT_SESSION_5_ID, SESSION_5],
  [CHAT_SESSION_8_ID, SESSION_8],
  [CHAT_SESSION_9_ID, SESSION_9],
  [CHAT_SESSION_10_ID, SESSION_10],
  [CHAT_SESSION_11_ID, SESSION_11],
  [CHAT_SESSION_12_ID, SESSION_12],
  [CHAT_SESSION_13_ID, SESSION_13],
  [CHAT_SESSION_14_ID, SESSION_14],
  [CHAT_SESSION_15_ID, SESSION_15],
  [CHAT_SESSION_16_ID, SESSION_16],
  [CHAT_SESSION_17_ID, SESSION_17],
  [CHAT_SESSION_18_ID, SESSION_18],
  [CHAT_SESSION_19_ID, SESSION_19],
  [CHAT_SESSION_20_ID, SESSION_20],
  [CHAT_SESSION_21_ID, SESSION_21],
  [CHAT_SESSION_22_ID, SESSION_22],
  [CHAT_SESSION_23_ID, SESSION_23],
])

// ─── Search + paginator helper ────────────────────────────────────────────────

function normalizeChatSearchText(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase().replaceAll('đ', 'd')
}

function isFuzzySubsequence(query: string, candidate: string): boolean {
  let queryIndex = 0
  for (const character of candidate) {
    if (character === query[queryIndex]) queryIndex += 1
    if (queryIndex === query.length) return true
  }
  return query.length === 0
}

export function makePagedChatSessions(page: number, query?: string): PagedResult<ChatSessionMeta> {
  const normalizedQuery = normalizeChatSearchText(query?.trim() ?? '')
  const matches = chatSessions
    .filter((session) => {
      if (normalizedQuery.length === 0) return true
      if (
        session.title &&
        isFuzzySubsequence(normalizedQuery, normalizeChatSearchText(session.title))
      ) {
        return true
      }
      return (
        chatSessionsById
          .get(session.id)
          ?.messages.some(
            (message) =>
              (message.role === 'user' || message.role === 'assistant') &&
              isFuzzySubsequence(normalizedQuery, normalizeChatSearchText(message.content)),
          ) ?? false
      )
    })
    .sort((left, right) => {
      // Mirrors the real query's `ORDER BY s.pinned_at DESC, s.updated_at DESC,
      // s.id DESC` (see `list_chat_sessions_paged`). `-Infinity` stands in for
      // NULL because SQLite sorts NULLs LAST on a DESC ordering, so unpinned
      // rows fall below every pinned one. The `!==` guard runs first, so two
      // unpinned rows never reach an `-Infinity - -Infinity` NaN.
      const leftPin = left.pinnedAt ?? -Infinity
      const rightPin = right.pinnedAt ?? -Infinity
      if (leftPin !== rightPin) return rightPin - leftPin
      if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt
      if (left.id === right.id) return 0
      return left.id < right.id ? 1 : -1
    })

  const pageSize = 10
  const offset = (Math.max(1, page) - 1) * pageSize
  return {
    items: matches.slice(offset, offset + pageSize),
    total: matches.length,
  }
}
