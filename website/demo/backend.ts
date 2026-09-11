import type { SearchFilters } from '../../src/types/entry'
import type { Entry } from '../../src/types/entry'
import { entries, entryContent, journalsById, tagsForEntry } from '../../web/fixtures/index'
import { chatSessionsById } from '../../web/fixtures/chat'
import { route } from '../../web/mocks/invokeRouter'
import { cancelAllStreams, cancelSessionStreams, cancelStream, streamReply } from './streaming'

export const DEMO_PASSWORD = 'memlore'
const now = () => Math.floor(Date.now() / 1000)
const uid = () => crypto.randomUUID()
let records = structuredClone(entries)
let documents = structuredClone(entryContent)
let sessions = structuredClone(chatSessionsById)
let secondPassword = DEMO_PASSWORD
let secondEnabled = true
const settings = new Map<string, unknown>()
const pinned = new Map<string, number>()
export function resetDemo() {
  cancelAllStreams()
  records = structuredClone(entries)
  documents = structuredClone(entryContent)
  sessions = structuredClone(chatSessionsById)
  settings.clear()
  pinned.clear()
  secondPassword = DEMO_PASSWORD
  secondEnabled = true
}
export function demoNotice(
  message = 'This action is simulated. Nothing is uploaded, downloaded, or sent to an AI provider.',
) {
  window.dispatchEvent(new CustomEvent('memlore-demo-notice', { detail: message }))
}
function visible(entry: Entry, args: Record<string, unknown>) {
  const journal = journalsById.get(entry.journal_id)
  if (entry.is_deleted) return false
  if (entry.is_invisible || journal?.is_invisible) {
    if (args.activeVaultId !== (entry.vault_id ?? 'demo-vault')) return false
  }
  if (args.lockFilter === 'invisibleLocked' && !(entry.is_invisible || journal?.is_invisible))
    return false
  if (args.lockFilter === 'secondLocked' && !(entry.is_locked || journal?.is_locked)) return false
  if (args.lockedView === 'hidden' && (entry.is_locked || journal?.is_locked)) return false
  return true
}
function page<T>(items: T[], args: Record<string, unknown>, size = 20) {
  const start = Math.max(0, Number(args.page ?? 1) - 1) * size
  return { items: structuredClone(items.slice(start, start + size)), total: items.length }
}
export async function demoInvoke(
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const id = String(args.id ?? args.entryId ?? '')
  const entry = records.find((item) => item.id === id)
  if (cmd === 'get_setting')
    return settings.has(String(args.key))
      ? settings.get(String(args.key))
      : args.key === 'second_lock_show_existence'
        ? 'true'
        : route(cmd, args)
  if (cmd === 'set_setting') {
    settings.set(String(args.key), args.value)
    return null
  }
  if (
    /^list_(all_entries|entries|favorite_entries|entries_by_tag)_paged$/.test(cmd) ||
    cmd === 'search_entries' ||
    cmd === 'semantic_search'
  ) {
    let items = records.filter((item) => visible(item, args))
    if (args.journalId) items = items.filter((item) => item.journal_id === args.journalId)
    if (cmd.includes('favorite') || args.favoritesOnly)
      items = items.filter((item) => item.is_favorite)
    if (args.tagId)
      items = items.filter((item) =>
        tagsForEntry.get(item.id)?.some((tag) => tag.id === args.tagId),
      )
    const filters = args.filters as SearchFilters | undefined
    if (filters?.journalIds?.length)
      items = items.filter((item) => filters.journalIds!.includes(item.journal_id))
    if (filters?.emotions?.length)
      items = items.filter((item) => item.emotion && filters.emotions!.includes(item.emotion))
    if (filters?.timeRange)
      items = items.filter(
        (item) =>
          item.entry_date >= filters.timeRange!.from &&
          item.entry_date < filters.timeRange!.toExclusive,
      )
    if (filters?.hasMedia)
      items = items.filter((item) =>
        filters.hasMedia === 'has' ? item.media_count > 0 : item.media_count === 0,
      )
    if (filters?.tagIds?.length)
      items = items.filter((item) =>
        tagsForEntry.get(item.id)?.some((tag) => filters.tagIds!.includes(tag.id)),
      )
    if (args.query)
      items = items.filter((item) =>
        `${item.title} ${item.content_text}`
          .toLowerCase()
          .includes(String(args.query).toLowerCase()),
      )
    items.sort((a, b) =>
      args.sort === 'oldest'
        ? a.entry_date - b.entry_date
        : args.sort === 'recentlyEdited'
          ? b.updated_at - a.updated_at
          : b.entry_date - a.entry_date,
    )
    if (cmd === 'search_entries') return structuredClone(items)
    if (cmd === 'semantic_search')
      return items.map((item) => ({
        entry_id: item.id,
        title: item.title,
        snippet: item.preview_text,
        score: 0.85,
        entry_date: item.entry_date,
      }))
    if (args.lockedView === 'covered')
      items = items.map((item) =>
        item.is_locked || journalsById.get(item.journal_id)?.is_locked
          ? {
              ...item,
              title: null,
              preview_text: null,
              content_text: null,
              is_locked: true,
              cover_media_id: null,
            }
          : item,
      )
    return page(items, args)
  }
  if (
    cmd === 'list_entry_dates' ||
    cmd === 'list_entries_for_date_range' ||
    cmd === 'count_entries_in_journal'
  ) {
    let items = records.filter(
      (item) => visible(item, args) && (!args.journalId || item.journal_id === args.journalId),
    )
    if (cmd === 'count_entries_in_journal') return items.length
    if (cmd === 'list_entry_dates') return items.map((item) => item.entry_date)
    items = items.filter(
      (item) => item.entry_date >= Number(args.fromTs) && item.entry_date < Number(args.toTs),
    )
    return structuredClone(items)
  }
  if (cmd === 'get_entry') return entry && visible(entry, args) ? structuredClone(entry) : null
  if (cmd === 'get_entry_content')
    return entry && visible(entry, args) ? (documents[id] ?? null) : null
  if (cmd === 'create_entry') {
    const item: Entry = {
      ...entries[0],
      id: uid(),
      journal_id: String(args.journalId ?? entries[0].journal_id),
      title: (args.title as string) ?? null,
      content_text: (args.contentText as string) ?? null,
      preview_text: (args.previewText as string) ?? null,
      entry_date: Number(args.entryDate ?? now()),
      created_at: now(),
      updated_at: now(),
      is_favorite: false,
      is_deleted: false,
      is_locked: false,
      is_invisible: false,
      vault_id: null,
      media_count: 0,
      cover_media_id: null,
      from_chat: false,
    }
    records.unshift(item)
    return structuredClone(item)
  }
  if (cmd === 'save_entry_content' && entry) {
    documents[id] = args.yjsDoc as number[]
    entry.content_text = args.contentText as string
    entry.preview_text = args.previewText as string
    entry.updated_at = now()
    return null
  }
  if (
    entry &&
    [
      'update_entry',
      'update_entry_emotion',
      'update_entry_date',
      'move_entry_to_journal',
      'update_entry_location',
      'update_entry_weather',
      'mark_entry_date_user_edited',
      'set_entry_locked',
      'set_entry_invisible',
      'soft_delete_entry',
      'toggle_favorite',
    ].includes(cmd)
  ) {
    const fields: Record<string, keyof Entry> = {
      title: 'title',
      contentText: 'content_text',
      previewText: 'preview_text',
      emotion: 'emotion',
      entryDate: 'entry_date',
      journalId: 'journal_id',
      latitude: 'latitude',
      longitude: 'longitude',
      locationLabel: 'location_label',
      locationAddress: 'location_address',
      weatherSummary: 'weather_summary',
      weatherIcon: 'weather_icon',
      locked: 'is_locked',
      invisible: 'is_invisible',
    }
    for (const [key, field] of Object.entries(fields))
      if (key in args) Object.assign(entry, { [field]: args[key] })
    if (cmd === 'set_entry_invisible')
      entry.vault_id = args.invisible ? String(args.activeVaultId ?? 'demo-vault') : null
    if (cmd === 'soft_delete_entry') entry.is_deleted = true
    if (cmd === 'toggle_favorite') entry.is_favorite = !entry.is_favorite
    if (cmd === 'mark_entry_date_user_edited') entry.entry_date_user_edited = true
    entry.updated_at = now()
    return cmd === 'toggle_favorite' ? entry.is_favorite : structuredClone(entry)
  }
  if (cmd === 'second_lock_status') return secondEnabled
  if (cmd === 'verify_second_lock_password') return args.password === secondPassword
  if (cmd === 'set_second_lock_password') {
    secondPassword = String(args.password)
    secondEnabled = true
    return null
  }
  if (cmd === 'disable_second_lock' || cmd === 'change_second_lock_password') {
    if ((args.password ?? args.oldPassword) !== secondPassword)
      throw new Error('Incorrect demo password. Use memlore.')
    if (cmd === 'disable_second_lock') {
      secondEnabled = false
      records.forEach((item) => {
        item.is_locked = false
      })
    } else secondPassword = String(args.newPassword)
    return null
  }
  if (cmd === 'open_or_create_invisible_vault')
    return args.password === DEMO_PASSWORD
      ? 'demo-vault'
      : `empty-vault-${String(args.password).length}`
  if (cmd === 'initialize_encryption') {
    if (args.password !== DEMO_PASSWORD) throw new Error('Incorrect demo password. Use memlore.')
    return null
  }
  if (cmd === 'lock_encryption') {
    cancelAllStreams()
    return null
  }
  if (cmd === 'daily_chat_create_session' || cmd === 'daily_chat_create_session_from_ask') {
    const sessionId = uid()
    sessions.set(sessionId, {
      id: sessionId,
      title: null,
      persona: 'empathetic',
      language: 'en',
      createdAt: now(),
      updatedAt: now(),
      messages: [],
      convertedEntryId: null,
      convertedThroughSeq: null,
    })
    return sessionId
  }
  const sessionId = String(args.sessionId ?? '')
  const session = sessions.get(sessionId)
  if (cmd === 'daily_chat_list_sessions_paged')
    return page(
      [...sessions.values()]
        .filter(
          (item) =>
            !args.query || item.title?.toLowerCase().includes(String(args.query).toLowerCase()),
        )
        .sort(
          (a, b) => (pinned.get(b.id) ?? 0) - (pinned.get(a.id) ?? 0) || b.updatedAt - a.updatedAt,
        )
        .map((item) => ({
          ...item,
          messageCount: item.messages.length,
          usedRag: false,
          pinnedAt: pinned.get(item.id) ?? null,
        })),
      args,
      10,
    )
  if (cmd === 'daily_chat_load_session') {
    if (!session) throw new Error('Demo conversation not found')
    return structuredClone(session)
  }
  if (cmd === 'daily_chat_delete_session') {
    cancelSessionStreams(sessionId)
    sessions.delete(sessionId)
    return null
  }
  if (cmd === 'daily_chat_rename_session' && session) {
    session.title = String(args.title)
    return null
  }
  if (cmd === 'daily_chat_set_session_pinned') {
    if (args.pinned) pinned.set(sessionId, now())
    else pinned.delete(sessionId)
    return null
  }
  if (cmd === 'daily_chat_generate_title' && session) {
    session.title ??=
      session.messages.find((message) => message.role === 'user')?.content.slice(0, 48) ??
      'A moment to reflect'
    return null
  }
  if (cmd === 'daily_chat_send_turn' && session) {
    const content = `This is a simulated reply to help you explore Memlore. It sounds like this moment matters to you. What is one small detail you would like to remember? You can write freely here, revisit this conversation, or save it as a journal entry. No AI service receives your message.`
    const append = (role: 'user' | 'assistant', text: string) => {
      session.messages.push({
        id: uid(),
        role,
        content: text,
        seq: (session.messages.at(-1)?.seq ?? 0) + 1,
        createdAt: now(),
      })
      session.updatedAt = now()
    }
    append('user', String(args.userText))
    streamReply(sessionId, String(args.turnId), content, () => append('assistant', content))
    return null
  }
  if (cmd === 'cancel_suggestion') {
    cancelStream(String(args.entryId))
    return null
  }
  if ((cmd === 'convert_chat_to_entry' || cmd === 'convert_chat_delta_to_entry') && session) {
    const messages = session.messages.filter(
      (message) =>
        cmd === 'convert_chat_to_entry' || message.seq > (session.convertedThroughSeq ?? 0),
    )
    return {
      markdown: messages
        .map(
          (message) =>
            `${message.role === 'user' ? '**You**' : '**Memlore (demo)**'}\n\n${message.content}`,
        )
        .join('\n\n'),
      throughSeq: session.messages.at(-1)?.seq ?? 0,
    }
  }
  if (cmd === 'chat_session_for_entry')
    return [...sessions.values()].find((item) => item.convertedEntryId === args.entryId)?.id ?? null
  if (cmd === 'daily_chat_mark_converted' && session) {
    session.convertedEntryId = String(args.entryId)
    session.convertedThroughSeq = Number(args.throughSeq)
    return null
  }
  if (
    /^(gdrive_|cloud_folder_|push_entry|export_|import_|download_|pick_|generate_inline_image)/.test(
      cmd,
    ) &&
    !/^(gdrive_get_status|gdrive_refresh_storage_quota|export_stats_file)/.test(cmd)
  )
    demoNotice()
  return route(cmd, args)
}
