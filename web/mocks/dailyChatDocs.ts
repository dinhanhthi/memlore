import type { Entry } from '../../src/types/entry'
import type { ChatSession } from '../../src/types/ai'
import type { PagedResult } from '../../src/types/pagination'
import { chatSessionsById, entryContent } from '../fixtures/index'

/** Distinctive phrases the daily-chat e2e asserts against. */
export const CHAT_SAVE_TITLE = 'Morning after the talk'
export const CHAT_SAVE_BODY = 'I felt the nerves ease after talking the Q&A through.'
export const CHAT_APPEND_BODY = 'The append-once lantern phrase stays unique.'

const createdEntries = new Map<string, Entry>()
const docs = new Map<string, number[]>()
const sessionOverlay = new Map<string, { convertedEntryId: string; convertedThroughSeq: number }>()
let createdSeq = 0

export function resetDailyChatDocs(): void {
  createdEntries.clear()
  docs.clear()
  sessionOverlay.clear()
  createdSeq = 0
}

export function createChatEntry(args: Record<string, unknown>): Entry {
  createdSeq += 1
  const now = Math.floor(Date.now() / 1000)
  const entry: Entry = {
    id: `chat-created-${createdSeq}`,
    journal_id: args.journalId as string,
    title: (args.title as string | undefined) ?? null,
    content_text: (args.contentText as string | undefined) ?? null,
    preview_text: (args.previewText as string | undefined) ?? null,
    entry_date: args.entryDate as number,
    created_at: now,
    updated_at: now,
    latitude: null,
    longitude: null,
    location_label: null,
    location_address: null,
    weather_summary: null,
    weather_icon: null,
    emotion: null,
    is_favorite: false,
    is_deleted: false,
    is_locked: false,
    is_invisible: false,
    vault_id: null,
    cover_media_id: null,
    content_language: 'en',
    entry_date_user_edited: false,
    media_count: 0,
    from_chat: true,
  }
  createdEntries.set(entry.id, entry)
  return entry
}

export function getCreatedEntry(id: string): Entry | undefined {
  return createdEntries.get(id)
}

export function listCreatedEntries(): Entry[] {
  return [...createdEntries.values()]
}

export function saveCreatedEntryContent(args: Record<string, unknown>): void {
  const id = args.id as string
  docs.set(id, args.yjsDoc as number[])
  const entry = createdEntries.get(id)
  if (entry) {
    entry.content_text = (args.contentText as string | undefined) ?? entry.content_text
    entry.preview_text = (args.previewText as string | undefined) ?? entry.preview_text
    entry.updated_at = Math.floor(Date.now() / 1000)
  }
}

export function getCreatedEntryContent(id: string): number[] | null {
  const saved = docs.get(id)
  if (saved) return saved
  if (createdEntries.has(id)) return null
  return entryContent[id] ?? null
}

export function convertChatToEntry(): { markdown: string; throughSeq: number } {
  return {
    markdown: `# ${CHAT_SAVE_TITLE}\n\n${CHAT_SAVE_BODY}`,
    throughSeq: 3,
  }
}

export function convertChatDeltaToEntry(): { markdown: string; throughSeq: number } {
  return {
    markdown: CHAT_APPEND_BODY,
    throughSeq: 5,
  }
}

export function markChatConverted(args: Record<string, unknown>): null {
  sessionOverlay.set(args.sessionId as string, {
    convertedEntryId: args.entryId as string,
    convertedThroughSeq: args.throughSeq as number,
  })
  return null
}

export function loadChatSession(args: Record<string, unknown>): ChatSession | null {
  const base = chatSessionsById.get(args.sessionId as string)
  if (!base) return null
  const overlay = sessionOverlay.get(args.sessionId as string)
  return overlay ? { ...base, ...overlay } : base
}

export function mergeCreatedIntoPaged(
  base: PagedResult<Entry>,
  created: Entry[],
): PagedResult<Entry> {
  if (created.length === 0) return base
  return {
    items: [...created, ...base.items],
    total: base.total + created.length,
  }
}

export function withCreatedPaged(
  baseFn: (args: Record<string, unknown>) => PagedResult<Entry>,
): (args: Record<string, unknown>) => PagedResult<Entry> {
  return (args) => {
    const journalId = args.journalId as string | undefined
    const created = listCreatedEntries().filter(
      (entry) => journalId == null || journalId === '' || entry.journal_id === journalId,
    )
    return mergeCreatedIntoPaged(baseFn(args), created)
  }
}
