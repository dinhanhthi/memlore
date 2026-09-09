import type { Scenario } from './types'
import type { EmotionKey, Entry } from '../../src/types/entry'
import { PAGE_SIZE, type PagedResult } from '../../src/types/pagination'
import type { UsagePeriod, AIFullSettings, AIProvidersConfig } from '../../src/types/ai'
import { useTabStore } from '../../src/stores/tabStore'
import { useInvisibleLockStore } from '../../src/stores/invisibleLockStore'
import { useSecondLockStore } from '../../src/stores/secondLockStore'
import { useSettingsStore } from '../../src/stores/settingsStore'
import { useOnboardingStore } from '../../src/stores/onboardingStore'
import type { Journal, Tag } from '../../src/types/journal'
import {
  journals,
  journalsById,
  entries,
  entriesById,
  entriesByJournal,
  tagsForEntry,
  tagsWithCounts,
  tags,
  templates,
  entryContent,
  listVersionsForEntry,
  getVersionContentForEntry,
  entriesOverTime,
  moodHistogram,
  moodTrend,
  tagFrequency,
  writingVolume,
  streakCalendar,
  locationDensity,
  streak,
  mediaByEntry,
  galleryMediaRows,
  mapPins,
  makeMediaStatusFor,
  photoBytesFor,
  aiAuditRows,
  makeAiUsageSummary,
  makePagedChatSessions,
  CHAT_SESSION_4_ID,
  makeConnectedDevices,
} from '../fixtures/index'
import {
  syncingEmits,
  syncErrorEmits,
  scopeUpgradeEmits,
  SYNC_STATUS_EVENT,
  makeSyncStatusEvent,
  connectedGDriveInvoke,
  makeSyncRecoveryStatus,
  recoveryCommandInvoke,
  recoveryStatusEmits,
} from './sync'
import { onboardNewDeviceInvoke } from './auth'
import { LOADING_INVOKE, pending } from './loading'
import { webGetSetting } from '../mocks/editorSettings'
import { FAKE_AI_PROVIDERS } from '../mocks/invokeRouter'
import { createAppleJournalImportScenario } from './appleJournalImport'
import { getMediaUploadLimits, setMediaUploadLimits } from '../mocks/mediaUploadLimits'
import {
  convertChatDeltaToEntry,
  convertChatToEntry,
  createChatEntry,
  getCreatedEntry,
  getCreatedEntryContent,
  loadChatSession,
  markChatConverted,
  saveCreatedEntryContent,
  withCreatedPaged,
} from '../mocks/dailyChatDocs'

/** Open Settings → Sync → Google Drive for recovery/visual scenarios. */
function seedGDriveSettings(): void {
  useTabStore.getState().updateActiveTab({
    activeView: 'settings',
    settingsCategory: 'sync',
    syncTab: 'gdrive',
  })
}

const CONNECTED_SYNC_STATUS = {
  enabled: true,
  configured: true,
  provider: 'gdrive',
  lastSync: Math.floor(Date.now() / 1000) - 5 * 60,
  entriesPending: 0,
}

/** Slice a list of entries into the PagedResult shape using the `page` arg. */
function paged(items: Entry[], args: Record<string, unknown> = {}): PagedResult<Entry> {
  const page = (args.page as number) ?? 1
  const start = (page - 1) * PAGE_SIZE
  return { items: items.slice(start, start + PAGE_SIZE), total: items.length }
}

/** Build a Journal from a create_journal / update_journal payload for the
 *  onboarding-wizard preview (so the journal step's commit resolves). */
function makePreviewJournal(args: Record<string, unknown>, fallbackId?: string): Journal {
  const payload = (args.payload ?? {}) as {
    id?: string
    name?: string
    color?: string
  }
  const now = Math.floor(Date.now() / 1000)
  return {
    id: payload.id ?? fallbackId ?? 'journal-web-new',
    name: payload.name ?? 'My Journal',
    color: payload.color ?? null,
    created_at: now,
    updated_at: now,
    sort_order: 0,
    is_deleted: false,
    is_locked: false,
    is_invisible: false,
    vault_id: null,
    is_initial_placeholder: false,
  }
}

/** Return entries matching a journal filter applied to a full list. */
function filterByJournal(journalId: string | undefined): Entry[] {
  if (!journalId) return entries
  return entriesByJournal.get(journalId) ?? []
}

function isJournalLocked(journalId: string): boolean {
  return journalsById.get(journalId)?.is_locked ?? false
}

function isJournalInvisible(journalId: string): boolean {
  return (
    (journalsById.get(journalId) as { is_invisible?: boolean } | undefined)?.is_invisible ?? false
  )
}

function applyCoveredView(items: Entry[], args: Record<string, unknown>): Entry[] {
  if (args.lockedView !== 'covered') return items

  return items.map((entry) => {
    const isLocked = entry.is_locked || isJournalLocked(entry.journal_id)
    if (!isLocked) return entry

    return {
      ...entry,
      title: null,
      preview_text: null,
      content_text: null,
      latitude: null,
      longitude: null,
      location_label: null,
      location_address: null,
      weather_summary: null,
      weather_icon: null,
      emotion: null,
      is_favorite: false,
      is_locked: true,
      cover_media_id: null,
      content_language: null,
      entry_date_user_edited: false,
    }
  })
}

/** Apply the lockFilter (secondLocked / invisibleLocked / all) using effective lock semantics (entry or journal).
 * "All" respects the current lockedView / activeVaultId (so turning off "Show existence of
 *   locked entries" actually hides them in the normal list).
 * "Second locked" does NOT surface when lockedView === 'hidden' (respects show-existence off).
 * "Invisible locked" only surfaces after the invisible session has been revealed.
 */
function applyLockFilter(items: Entry[], args: Record<string, unknown>): Entry[] {
  const lockFilter = (args.lockFilter as string | undefined) ?? 'all'

  if (lockFilter === 'secondLocked') {
    const lockedView = args.lockedView as string | undefined
    if (lockedView === 'hidden') {
      // Respect "Show existence of locked entries" = off.
      // Even the "Second locked" filter does not surface them when Hidden.
      return []
    }
    return applyCoveredView(
      items.filter((e) => e.is_locked || isJournalLocked(e.journal_id)),
      args,
    )
  }
  if (lockFilter === 'invisibleLocked') {
    const vaultId = args.activeVaultId as string | null | undefined
    if (vaultId == null || vaultId === '') {
      // Invisible lock is still locked → filter shows nothing.
      return []
    }
    return items.filter((e) => {
      if (!(e.is_invisible || isJournalInvisible(e.journal_id))) return false
      // Multi-vault: only the open vault's rows (vault_id match or legacy null vault).
      const entryVault = e.vault_id
      const journal = journalsById.get(e.journal_id)
      const journalVault = journal?.vault_id ?? null
      const effective = entryVault ?? journalVault
      return effective == null || effective === vaultId
    })
  }
  // "All" — apply normal visibility rules (so "Show existence of locked entries" off
  // actually hides second-locked entries in the regular list).
  const lockedView = args.lockedView as string | undefined
  const vaultId = args.activeVaultId as string | null | undefined

  let result = items
  if (lockedView === 'hidden') {
    result = result.filter((e) => !(e.is_locked || isJournalLocked(e.journal_id)))
  }
  if (vaultId == null || vaultId === '') {
    result = result.filter((e) => !(e.is_invisible || isJournalInvisible(e.journal_id)))
  } else {
    result = result.filter((e) => {
      if (!(e.is_invisible || isJournalInvisible(e.journal_id))) return true
      const entryVault = e.vault_id
      const journal = journalsById.get(e.journal_id)
      const journalVault = journal?.vault_id ?? null
      const effective = entryVault ?? journalVault
      return effective == null || effective === vaultId
    })
  }
  return applyCoveredView(result, args)
}

/** Calendar/stats surfaces: respect lockedView + activeVaultId like the backend. */
function applyCalendarVisibility(items: Entry[], args: Record<string, unknown>): Entry[] {
  const lockedView = args.lockedView as string | undefined
  const vaultId = args.activeVaultId as string | null | undefined

  let result = items
  if (lockedView === 'hidden') {
    result = result.filter((e) => !(e.is_locked || isJournalLocked(e.journal_id)))
  }
  if (vaultId == null || vaultId === '') {
    result = result.filter((e) => !(e.is_invisible || isJournalInvisible(e.journal_id)))
  } else {
    result = result.filter((e) => {
      if (!(e.is_invisible || isJournalInvisible(e.journal_id))) return true
      const entryVault = e.vault_id
      const journal = journalsById.get(e.journal_id)
      const journalVault = journal?.vault_id ?? null
      const effective = entryVault ?? journalVault
      return effective == null || effective === vaultId
    })
  }
  return result
}

function entryDateIso(entry: Entry): string {
  return new Date(entry.entry_date * 1000).toISOString().slice(0, 10)
}

/**
 * Shared invoke overrides used by the 'logged-in' scenario and all sync
 * scenarios. Sync scenarios spread this map and override only `get_sync_status`
 * (and optionally `get_sync_scope_upgrade_required`).
 */
const LOGGED_IN_INVOKE: Scenario['invoke'] = {
  // ── Auth ──────────────────────────────────────────────────────────────
  // 'password' + initialized: true — the key is already loaded (unlocked),
  // matching what "logged in" means for every scenario spreading this map.
  // `false` here would render LockScreen instead (see the `locked` scenario).
  get_encryption_mode: 'password',
  is_encryption_initialized: true,
  get_force_re_pair_status: null,

  // ── Journals ──────────────────────────────────────────────────────────
  list_journals: journals,
  get_journal: (args: Record<string, unknown>) => journalsById.get(args.id as string) ?? null,
  count_entries_in_journal: (args: Record<string, unknown>) =>
    (entriesByJournal.get(args.journalId as string) ?? []).length,

  // ── Entries (paginated surfaces) ───────────────────────────────────────
  list_all_entries_paged: (args: Record<string, unknown>) =>
    paged(applyLockFilter(entries, args), args),
  list_entries_paged: (args: Record<string, unknown>) => {
    const base = filterByJournal(args.journalId as string | undefined)
    return paged(applyLockFilter(base, args), args)
  },
  list_favorite_entries_paged: (args: Record<string, unknown>) => {
    const journalId = args.journalId as string | undefined | null
    const pool = journalId ? (entriesByJournal.get(journalId) ?? []) : entries
    const favs = pool.filter((e) => e.is_favorite)
    return paged(applyLockFilter(favs, args), args)
  },
  list_entries_by_tag_paged: (args: Record<string, unknown>) => {
    const tagId = args.tagId as string
    const favoritesOnly = args.favoritesOnly as boolean | undefined
    const tagged = Array.from(tagsForEntry.entries())
      .filter(([, entryTags]) => entryTags.some((t) => t.id === tagId))
      .map(([entryId]) => entriesById.get(entryId))
      .filter((e): e is Entry => e !== undefined)
      .filter((e) => !favoritesOnly || e.is_favorite)
    return paged(applyLockFilter(tagged, args), args)
  },

  // ── Entries (non-paginated) ────────────────────────────────────────────
  list_entries_for_date_range: (args: Record<string, unknown>) => {
    const fromTs = args.fromTs as number
    const toTs = args.toTs as number
    const journalId = args.journalId as string | null | undefined
    const pool = journalId ? (entriesByJournal.get(journalId) ?? []) : entries
    return pool.filter((e) => e.entry_date >= fromTs && e.entry_date < toTs)
  },
  list_entry_dates: (args: Record<string, unknown>) => {
    const journalId = args.journalId as string | null | undefined
    const pool = journalId ? (entriesByJournal.get(journalId) ?? []) : entries
    return pool.map((e) => e.entry_date)
  },
  list_on_this_day: (args: Record<string, unknown>) => {
    const month = args.month as number
    const day = args.day as number
    return entries.filter((e) => {
      const d = new Date(e.entry_date * 1000)
      return d.getMonth() + 1 === month && d.getDate() === day
    })
  },
  get_entry: (args: Record<string, unknown>) => {
    const entry = entriesById.get(args.id as string)
    if (!entry) return null
    // Mirror backend multi-vault gate: invisible entries (or journals) are
    // only readable when the matching vault is open.
    if (entry.is_invisible || isJournalInvisible(entry.journal_id)) {
      const vaultId = args.activeVaultId as string | null | undefined
      if (vaultId == null || vaultId === '') return null
      const entryVault = entry.vault_id
      const journal = journalsById.get(entry.journal_id)
      const journalVault = journal?.vault_id ?? null
      const effective = entryVault ?? journalVault
      if (effective != null && effective !== vaultId) return null
    }
    return entry
  },
  create_entry: (args: Record<string, unknown>) => ({
    ...entries[0],
    journal_id: args.journalId as string,
    title: (args.title as string | undefined) ?? null,
    content_text: (args.contentText as string | undefined) ?? null,
    preview_text: (args.previewText as string | undefined) ?? null,
    entry_date: args.entryDate as number,
  }),

  get_media_upload_limits: getMediaUploadLimits,
  set_media_upload_limits: setMediaUploadLimits,
  get_media_cache_stats: { usedBytes: 0, maxBytes: 512 * 1024 * 1024 },

  // ── Entry content (Yjs binary) ─────────────────────────────────────────
  get_entry_content: (args: Record<string, unknown>) => entryContent[args.id as string] ?? null,

  // ── Entry version history ─────────────────────────────────────────────
  list_entry_versions: (args: Record<string, unknown>) =>
    listVersionsForEntry(args.entryId as string),
  get_entry_version_content: (args: Record<string, unknown>) =>
    getVersionContentForEntry(args.versionId as string, args.entryId as string),
  get_version_retention_days: 7,
  set_version_retention_days: null,
  snapshot_entry_version: (args: Record<string, unknown>) =>
    `version-snapshot-${String(args.entryId)}-${Date.now()}`,

  // ── Tags ──────────────────────────────────────────────────────────────
  list_tags: tags,
  get_tags_with_counts: tagsWithCounts,
  get_tags_for_entry: (args: Record<string, unknown>) =>
    tagsForEntry.get(args.entryId as string) ?? [],
  get_tags_for_entries: (args: Record<string, unknown>) => {
    const result: Record<string, Tag[]> = {}
    const vaultId = args.activeVaultId as string | null | undefined
    const unlocked = vaultId != null && vaultId !== ''
    for (const entryId of args.entryIds as string[]) {
      const entry = entriesById.get(entryId)
      if (!entry) continue
      if (entry.is_invisible || isJournalInvisible(entry.journal_id)) {
        if (!unlocked) continue
        const entryVault = entry.vault_id
        const journal = journalsById.get(entry.journal_id)
        const journalVault = journal?.vault_id ?? null
        const effective = entryVault ?? journalVault
        if (effective != null && effective !== vaultId) continue
      }
      const entryTags = tagsForEntry.get(entryId)
      if (entryTags?.length) result[entryId] = entryTags
    }
    return result
  },

  // ── Templates ─────────────────────────────────────────────────────────
  list_templates: templates,

  // ── Emotion calendar ──────────────────────────────────────────────────
  get_emotion_by_date: (args: Record<string, unknown>) => {
    const year = args.year as number
    const pairs: Array<[string, EmotionKey]> = []
    const seen = new Set<string>()
    for (const entry of applyCalendarVisibility(entries, args)) {
      if (entry.emotion === null) continue
      const dateStr = entryDateIso(entry)
      if (!dateStr.startsWith(String(year))) continue
      const key = `${dateStr}:${entry.emotion}`
      if (seen.has(key)) continue
      seen.add(key)
      pairs.push([dateStr, entry.emotion])
    }
    return pairs.sort(([a], [b]) => a.localeCompare(b))
  },

  // ── Entry frequency (calendar heatmap) ────────────────────────────────
  get_entry_frequency: (args: Record<string, unknown>) => {
    const year = args.year as number
    const counts = new Map<string, number>()
    for (const entry of applyCalendarVisibility(entries, args)) {
      const dateStr = entryDateIso(entry)
      if (!dateStr.startsWith(String(year))) continue
      counts.set(dateStr, (counts.get(dateStr) ?? 0) + 1)
    }
    return Array.from(counts.entries()).sort(([a], [b]) => a.localeCompare(b))
  },

  // ── Media ─────────────────────────────────────────────────────────────
  list_media_for_entry: (args: Record<string, unknown>) =>
    mediaByEntry[args.entryId as string] ?? [],
  list_all_media_paged: (args: Record<string, unknown>) => {
    const kind = args.kind as string | null
    const page = (args.page as number) ?? 1
    const PAGE_SIZE = 20
    const filtered = kind
      ? galleryMediaRows.filter((r) => r.fileType.startsWith(kind + '/'))
      : galleryMediaRows
    const total = filtered.length
    const start = (page - 1) * PAGE_SIZE
    return { items: filtered.slice(start, start + PAGE_SIZE), total }
  },
  get_media_status: (args: Record<string, unknown>) => makeMediaStatusFor(args.mediaId as string),
  // Full file for lightbox / editor; thumbnail for gallery grid cells.
  // Both used to share the 200×200 crop, so the carousel looked tiny.
  read_media_bytes: (args: Record<string, unknown>) =>
    photoBytesFor(args.mediaId as string, { size: 'full' }),
  read_media_thumbnail_bytes: (args: Record<string, unknown>) =>
    photoBytesFor(args.mediaId as string, { size: 'thumb' }),

  // ── AI audit log ──────────────────────────────────────────────────────
  list_ai_audit_log: aiAuditRows,
  get_ai_audit_retention_days: 90,

  // ── AI usage ──────────────────────────────────────────────────────────
  summarize_ai_usage: (args: Record<string, unknown>) =>
    makeAiUsageSummary((args.period as UsagePeriod | undefined) ?? '30d'),

  // ── Map ───────────────────────────────────────────────────────────────
  list_map_pins: mapPins,

  // ── Streaks ───────────────────────────────────────────────────────────
  get_streak: streak,
  recalculate_streak: streak,

  // ── Stats ─────────────────────────────────────────────────────────────
  stats_entries_over_time: (_args: Record<string, unknown>) => entriesOverTime,
  stats_mood_histogram: (_args: Record<string, unknown>) => moodHistogram,
  stats_mood_trend: (_args: Record<string, unknown>) => moodTrend,
  stats_tag_frequency: tagFrequency,
  stats_writing_volume: (_args: Record<string, unknown>) => writingVolume,
  stats_streak_calendar: (_args: Record<string, unknown>) => streakCalendar,
  stats_location_density: locationDensity,

  // ── Misc ──────────────────────────────────────────────────────────────
  list_location_aliases: [],
  get_device_id: 'web-preview-device',
  list_devices: [],
  refresh_devices_from_cloud: [],
  get_sync_status: {
    enabled: true,
    configured: true,
    provider: 'gdrive',
    lastSync: null,
    entriesPending: 0,
  },
  get_sync_catchup_status: { complete: false, pulled: 17, total: 42 },
  get_sync_settings: { intervalMinutes: 0, onSave: false, onLaunch: false },
  get_sync_scope_upgrade_required: false,
}

/**
 * AI provider/feature mocks shared by the `onboarding-wizard` (AIStep inside
 * the wizard) and `ai-step` (AIStep standalone) scenarios. Provider reads use
 * the shared web-preview snapshot, every feature starts off, and every write
 * command resolves to a valid result — the "fake approval" — so each AIStep
 * sub-stage is walkable in the preview even though there's no real backend.
 * Without the write mocks, unmocked commands resolve to `null` and AIStep's
 * `result.requiresPrivacyConsent` read throws, stranding the user.
 */
const AI_PREVIEW_INVOKE: NonNullable<Scenario['invoke']> = {
  get_ai_settings: {
    provider: null,
    endpoint: null,
    endpointClass: null,
    chatModel: null,
    embeddingModel: null,
    hasApiKey: false,
    privacyAcceptedAt: null,
    semanticSearchEnabled: false,
    emotionSuggestionsEnabled: false,
    titleSuggestionsEnabled: false,
    entryHighlightsEnabled: false,
    goDeeperEnabled: false,
    continueWritingEnabled: false,
    dailyChatEnabled: false,
    chatMemoryEnabled: false,
    imageGenerationEnabled: false,
    multiEntrySummaryEnabled: false,
    periodicReviewEnabled: false,
    insightsEnabled: false,
    dashboardInsightsEnabled: false,
    tagSuggestionsEnabled: false,
    chatRagEnabled: false,
    // Master User Memory preference off in this fixture; slots also empty.
    userMemoryEnabled: false,
    personaEnabled: false,
    memoryGenProvider: null,
    memoryGenEndpoint: null,
    memoryGenEndpointClass: null,
    memoryGenChatModel: null,
    memoryGenHasApiKey: false,
    memoryEmbedProvider: null,
    memoryEmbedEndpoint: null,
    memoryEmbedEndpointClass: null,
    memoryEmbedEmbeddingModel: null,
    memoryEmbedHasApiKey: false,
    titleSuggestionsSystemPrompt: '',
    entryHighlightsSystemPrompt: '',
    multiEntrySummarySystemPrompt: '',
    goDeeperSystemPrompt: '',
    dailyChatPersona: 'empathetic',
    dailyChatCustomPersona: '',
    dailyChatAiTitle: false,
    responseLanguage: 'auto',
    emotionSuggestionLanguage: 'auto',
  } satisfies AIFullSettings,
  get_ai_providers: FAKE_AI_PROVIDERS,
  set_ai_generation_provider: (args: Record<string, unknown>) => ({
    provider: (args.input as { provider?: string }).provider ?? '',
    endpointClass: 'remote',
    requiresPrivacyConsent: false,
  }),
  set_ai_embedding_provider: (args: Record<string, unknown>) => ({
    provider: (args.input as { provider?: string }).provider ?? '',
    endpointClass: 'remote',
    requiresPrivacyConsent: false,
  }),
  test_ai_generation_provider: { latencyMs: 120, dim: null },
  test_ai_embedding_provider: { latencyMs: 140, dim: 768 },
  accept_ai_privacy: Date.now(),
  set_ai_feature: null,
}

const aiConnectedFeaturePrompts = {
  titleSuggestionsSystemPrompt: '',
  entryHighlightsSystemPrompt: '',
  multiEntrySummarySystemPrompt: '',
  goDeeperSystemPrompt: '',
}

/** Every AI feature on, Ollama local provider. A factory (not a literal) so it
 *  picks up prompt edits made through `setAiConnectedFeaturePrompt`. Shared by
 *  the `ai-connected` and `loading` scenarios — the latter needs
 *  `dailyChatEnabled: true` for the Chat nav item to exist at all. */
function aiConnectedSettings(): AIFullSettings {
  return {
    provider: 'ollama',
    endpoint: 'http://127.0.0.1:11434/v1',
    endpointClass: 'local',
    chatModel: 'qwen3.5:4b',
    embeddingModel: 'nomic-embed-text',
    hasApiKey: false,
    privacyAcceptedAt: null,
    semanticSearchEnabled: true,
    emotionSuggestionsEnabled: true,
    titleSuggestionsEnabled: true,
    entryHighlightsEnabled: true,
    goDeeperEnabled: true,
    continueWritingEnabled: true,
    dailyChatEnabled: true,
    chatMemoryEnabled: true,
    // Image gen is part of the "all AI on" fixture so the editor footer
    // Generate Image button is visible in web preview (the hook
    // `useAiImageGenerationEnabled` returns null/'off' when this is false).
    imageGenerationEnabled: true,
    multiEntrySummaryEnabled: true,
    periodicReviewEnabled: true,
    insightsEnabled: true,
    dashboardInsightsEnabled: true,
    tagSuggestionsEnabled: true,
    chatRagEnabled: true,
    // Both memory slots point at the same local Ollama endpoint, so the
    // Memories page previews in its fully-configured state like every other
    // feature in this scenario.
    userMemoryEnabled: true,
    personaEnabled: true,
    memoryGenProvider: 'ollama',
    memoryGenEndpoint: 'http://127.0.0.1:11434/v1',
    memoryGenEndpointClass: 'local',
    memoryGenChatModel: 'qwen3.5:4b',
    memoryGenHasApiKey: false,
    memoryEmbedProvider: 'ollama',
    memoryEmbedEndpoint: 'http://127.0.0.1:11434/v1',
    memoryEmbedEndpointClass: 'local',
    memoryEmbedEmbeddingModel: 'nomic-embed-text',
    memoryEmbedHasApiKey: false,
    ...aiConnectedFeaturePrompts,
    dailyChatPersona: 'empathetic',
    dailyChatCustomPersona: '',
    dailyChatAiTitle: false,
    responseLanguage: 'auto',
    emotionSuggestionLanguage: 'auto',
  }
}

function setAiConnectedFeaturePrompt(args: Record<string, unknown>): null {
  const prompt = typeof args.prompt === 'string' ? args.prompt : ''

  switch (args.feature) {
    case 'title_suggestions':
      aiConnectedFeaturePrompts.titleSuggestionsSystemPrompt = prompt
      break
    case 'entry_highlights':
      aiConnectedFeaturePrompts.entryHighlightsSystemPrompt = prompt
      break
    case 'multi_entry_summary':
      aiConnectedFeaturePrompts.multiEntrySummarySystemPrompt = prompt
      break
    case 'go_deeper':
      aiConnectedFeaturePrompts.goDeeperSystemPrompt = prompt
      break
  }

  return null
}

export const scenarios: Scenario[] = [
  // --- auth group ---
  {
    id: 'locked',
    label: 'Locked',
    group: 'auth',
    componentFile: 'LockScreen.tsx',
    invoke: {
      get_encryption_mode: 'password',
      is_encryption_initialized: false,
      get_force_re_pair_status: null,
    },
  },
  {
    // LockScreen frozen with the Unlock button in its loading state. The
    // `initialize_encryption` override never settles, so `isLoading` stays
    // true and the primary button shows its searching orb indefinitely — used
    // to preview the orb's brightness/contrast on the primary gradient.
    id: 'locked-loading',
    label: 'Locked (loading)',
    group: 'auth',
    componentFile: 'LockScreen.tsx',
    invoke: {
      get_encryption_mode: 'password',
      is_encryption_initialized: false,
      get_force_re_pair_status: null,
      initialize_encryption: pending,
    },
    afterMount: () => {
      // Fill the password field and submit so handleSubmit flips `isLoading`
      // on and parks on the never-resolving initialize_encryption promise.
      const input = document.querySelector<HTMLInputElement>('input[type="password"]')
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        setter?.call(input, 'preview')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
      // Submit on a later tick — the submit handler closes over `password`
      // state, so firing it in the same tick as the input event sees the
      // pre-update empty value and bails out of the loading state.
      setTimeout(() => document.querySelector<HTMLFormElement>('form')?.requestSubmit(), 50)
    },
  },
  {
    // WelcomeScreen rendered standalone (same as App.tsx mounts it
    // during onboarding). The step selector jumps straight to any of its
    // in-place screens; `setup-wizard` / `onboard-existing` route to their own
    // components (covered by other scenarios) and are not exposed here.
    id: 'onboarding',
    label: 'Onboarding',
    group: 'auth',
    componentFile: 'WelcomeScreen.tsx',
    invoke: {
      get_encryption_mode: 'unset',
      is_encryption_initialized: false,
      get_force_re_pair_status: null,
      gdrive_get_status: { connected: false },
      gdrive_disconnect: null,
    },
    preview: { kind: 'welcome' },
    steps: {
      label: 'Screen',
      options: [
        { id: 'language', label: 'Language' },
        { id: 'intro', label: 'Intro' },
        { id: 'cloud-empty-prompt', label: 'Cloud empty' },
      ],
    },
  },
  {
    // The post-setup wizard (theme → name journal → Drive → AI), rendered on
    // its own via the `onboarding-wizard` preview so each step's UI can be
    // checked without walking through the whole first-run flow. The
    // interface-language screen is NOT here — it lives on the welcome screen
    // (the `onboarding` scenario above), before the vault exists.
    id: 'onboarding-wizard',
    label: 'Onboarding: wizard steps',
    group: 'auth',
    // Starts on theme; step components live under onboarding/steps/.
    componentFile: 'OnboardingWizard.tsx',
    componentName: 'ThemeStep',
    invoke: {
      get_encryption_mode: 'password',
      is_encryption_initialized: false,
      get_force_re_pair_status: null,
      // Theme step — accent/font settings load lazily; fall back to defaults.
      get_setting: (args: Record<string, unknown>) => webGetSetting(args),
      set_setting: null,
      // Journal step — start with no journals so it's in "create" mode.
      list_journals: [],
      create_journal: (args: Record<string, unknown>) =>
        makePreviewJournal(args, 'journal-web-new'),
      update_journal: (args: Record<string, unknown>) => makePreviewJournal(args),
      // Drive step — start disconnected so the Connect button shows.
      gdrive_get_status: { connected: false },
      gdrive_begin_connect: { sessionId: 'web-preview', authUrl: 'about:blank' },
      // AI step — nothing configured yet + fake write approvals (see const).
      ...AI_PREVIEW_INVOKE,
    },
    seedStores: () => {
      // The wizard reads encryptionMode and the pending flag from these
      // stores. Password is mandatory from vault creation onward, so by
      // the time this wizard runs the mode is always 'password'.
      useSettingsStore.getState().setEncryptionMode('password')
      useOnboardingStore.getState().setPending()
    },
    preview: { kind: 'onboarding-wizard' },
  },
  {
    // AIStep rendered standalone (no wizard "Step 4 of 4" chrome) so each of
    // its sub-stages can be opened directly via the step selector. Shares the
    // AI mocks with `onboarding-wizard` (fake provider approval + test results)
    // so the whole enable → provider → gen_config → embedding → features flow
    // is walkable. `gen_config` seeds the first generation preset (AIStep does
    // this when `initialStage === 'gen_config'`) so the config form renders.
    id: 'ai-step',
    label: 'Onboarding: AI step',
    group: 'auth',
    componentFile: 'AIStep.tsx',
    invoke: {
      get_encryption_mode: 'password',
      is_encryption_initialized: false,
      get_force_re_pair_status: null,
      ...AI_PREVIEW_INVOKE,
    },
    preview: { kind: 'ai-step' },
    steps: {
      label: 'Stage',
      options: [
        { id: 'enable', label: 'Enable' },
        { id: 'provider', label: 'Provider' },
        { id: 'gen_config', label: 'Gen config' },
        { id: 'embedding', label: 'Embedding' },
        { id: 'features', label: 'Features' },
      ],
    },
  },
  {
    // useForceRePair reads get_force_re_pair_status; non-null value triggers ForceRePairScreen.
    id: 'force-re-pair',
    label: 'Force re-pair',
    group: 'auth',
    componentFile: 'ForceRePairScreen.tsx',
    invoke: {
      get_encryption_mode: 'password',
      is_encryption_initialized: false,
      get_force_re_pair_status: 'key-rotation',
      complete_force_re_pair: null,
    },
  },
  {
    id: 'onboard-new-device',
    label: 'Onboard: recovery phrase',
    group: 'auth',
    // Two screens share one export; section is the `step === 'passphrase'` branch.
    componentFile: 'OnboardNewDeviceScreen.tsx',
    componentName: 'passphrase',
    invoke: onboardNewDeviceInvoke,
    preview: { kind: 'onboard-new-device', initialStep: 'passphrase' },
  },
  {
    id: 'onboard-new-device-unlock-method',
    label: 'Onboard: unlock method',
    group: 'auth',
    // Same export; section is the `step === 'unlock_method'` branch — the join
    // flow's copy of the first-run unlock picker (UnlockMethodPicker).
    componentFile: 'OnboardNewDeviceScreen.tsx',
    componentName: 'unlock method',
    invoke: onboardNewDeviceInvoke,
    preview: { kind: 'onboard-new-device', initialStep: 'unlock_method' },
  },
  {
    id: 'onboard-new-device-password',
    label: 'Onboard: set device password',
    group: 'auth',
    // Two screens share one export; section is the password branch (default return).
    componentFile: 'OnboardNewDeviceScreen.tsx',
    componentName: 'password',
    invoke: onboardNewDeviceInvoke,
    preview: { kind: 'onboard-new-device', initialStep: 'password' },
  },
  // --- app group ---
  {
    id: 'logged-in-empty',
    label: 'Logged in (empty)',
    group: 'app',
    componentFile: 'TwoPanelLayout.tsx',
    invoke: {
      get_encryption_mode: 'password',
      is_encryption_initialized: true,
      get_force_re_pair_status: null,
      get_sync_status: {
        enabled: true,
        configured: true,
        provider: 'gdrive',
        lastSync: null,
        entriesPending: 0,
      },
      get_sync_catchup_status: { complete: false, pulled: 17, total: 42 },
    },
  },
  {
    id: 'logged-in',
    label: 'Logged in (rich)',
    group: 'app',
    componentFile: 'TwoPanelLayout.tsx',
    invoke: { ...LOGGED_IN_INVOKE },
  },
  {
    id: 'dashboard',
    label: 'Dashboard',
    group: 'app',
    componentFile: 'TwoPanelLayout.tsx',
    invoke: { ...LOGGED_IN_INVOKE },
    seedStores: () => {
      useTabStore.getState().updateActiveTab({ activeView: 'dashboard', selectedEntryId: null })
    },
  },
  {
    // Tags page with no tags created yet — exercises the "No tags yet" empty
    // state. Everything else (entries, journals) stays populated; only the tag
    // surfaces are emptied. Opens directly on the Tags view.
    id: 'logged-in-no-tags',
    label: 'Logged in: no tags yet',
    group: 'app',
    componentFile: 'TwoPanelLayout.tsx',
    invoke: {
      ...LOGGED_IN_INVOKE,
      list_tags: [],
      get_tags_with_counts: [],
      get_tags_for_entry: [],
      get_tags_for_entries: {},
    },
    seedStores: () => {
      useTabStore.getState().updateActiveTab({ activeView: 'tags' })
    },
  },
  {
    // Full app with both lock layers enabled and their sessions unlocked, so
    // second-locked and invisible entries surface in the list — useful for
    // previewing the lock-marker border styling on EntryCard.
    id: 'logged-in-locks-revealed',
    label: 'Logged in: lock markers revealed',
    group: 'app',
    componentFile: 'TwoPanelLayout.tsx',
    invoke: {
      ...LOGGED_IN_INVOKE,
      second_lock_status: true,
      get_setting: (args: Record<string, unknown>) => {
        const editorDefault = webGetSetting(args)
        if (editorDefault !== null) return editorDefault
        const key = args.key as string
        if (key === 'second_lock_show_existence') return 'true'
        return null
      },
    },
    seedStores: () => {
      useSecondLockStore.getState().setEnabled(true)
      useSecondLockStore.getState().unlockSession()
      useInvisibleLockStore.getState().unlockSession('vault-a')
    },
  },
  {
    // Cold-cache pass over the whole app: every page-level data command is
    // frozen in its pending state (see `loading.ts`), so each view renders the
    // placeholder it shows before real data lands. Navigate with the sidebar —
    // Entries, Calendar, Tags, On This Day, Media, Map, Statistics, Chat all
    // stay loading indefinitely.
    id: 'loading',
    label: 'Loading (all pages)',
    group: 'app',
    componentFile: 'TwoPanelLayout.tsx',
    componentName: 'loading placeholders',
    invoke: {
      ...LOGGED_IN_INVOKE,
      // Chat is nav-gated on `dailyChatEnabled`; without this the sidebar item
      // never renders and its loading state is unreachable.
      get_ai_settings: aiConnectedSettings,
      ...LOADING_INVOKE,
    },
    seedStores: () => {
      // Start on Entries regardless of the view the previous scenario left in
      // the persisted tab state.
      useTabStore.getState().updateActiveTab({ activeView: 'entries', selectedEntryId: null })
    },
  },
  {
    id: 'stats-ai-audit',
    label: 'Statistics: AI audit log',
    group: 'app',
    componentFile: 'AiAuditLogPanel.tsx',
    invoke: {
      ...LOGGED_IN_INVOKE,
      // Keep the initially-mounted Charts tab from creating Leaflet inside a
      // hidden zero-width panel before this scenario switches to AI audit.
      stats_location_density: [],
    },
  },
  // --- sync group ---
  {
    id: 'sync-off',
    label: 'Sync: off',
    group: 'sync',
    componentFile: 'SyncStatus.tsx',
    invoke: {
      ...LOGGED_IN_INVOKE,
      // Explicit override to protect this scenario if LOGGED_IN_INVOKE default ever changes
      get_sync_status: {
        enabled: false,
        configured: false,
        provider: null,
        lastSync: null,
        entriesPending: 0,
      },
    },
  },
  {
    id: 'gdrive-connected',
    label: 'Sync: GDrive connected',
    group: 'sync',
    componentFile: 'SyncStatus.tsx',
    invoke: {
      ...LOGGED_IN_INVOKE,
      ...connectedGDriveInvoke({ lastSync: undefined }),
      list_devices: makeConnectedDevices,
      refresh_devices_from_cloud: makeConnectedDevices,
      get_sync_status: {
        enabled: true,
        configured: true,
        provider: 'gdrive',
        lastSync: null,
        entriesPending: 0,
      },
    },
  },
  {
    id: 'syncing',
    label: 'Sync: syncing (animated)',
    group: 'sync',
    componentFile: 'SyncStatus.tsx',
    invoke: {
      ...LOGGED_IN_INVOKE,
      ...connectedGDriveInvoke({ lastSync: undefined }),
      get_sync_status: {
        enabled: true,
        configured: true,
        provider: 'gdrive',
        lastSync: null,
        entriesPending: 3,
      },
    },
    emitOnLoad: syncingEmits,
  },
  {
    id: 'synced',
    label: 'Sync: synced',
    group: 'sync',
    componentFile: 'SyncStatus.tsx',
    invoke: {
      ...LOGGED_IN_INVOKE,
      ...connectedGDriveInvoke(),
      // lastSync computed lazily at activation time via get_sync_status factory
      get_sync_status: (_args: Record<string, unknown>) => ({
        enabled: true,
        configured: true,
        provider: 'gdrive',
        lastSync: Math.floor(Date.now() / 1000) - 5 * 60,
        entriesPending: 0,
      }),
    },
    // Factory evaluated at scenario activation time so lastSync is always "5 min ago"
    emitOnLoad: () => [
      {
        event: SYNC_STATUS_EVENT,
        payload: makeSyncStatusEvent({
          state: 'synced',
          lastSync: Math.floor(Date.now() / 1000) - 5 * 60,
          entriesPending: 0,
        }),
        delayMs: 0,
      },
    ],
  },
  {
    id: 'sync-error',
    label: 'Sync: error',
    group: 'sync',
    componentFile: 'SyncStatus.tsx',
    invoke: {
      ...LOGGED_IN_INVOKE,
      ...connectedGDriveInvoke(),
      get_sync_status: {
        enabled: true,
        configured: true,
        provider: 'gdrive',
        lastSync: null,
        entriesPending: 2,
      },
    },
    emitOnLoad: syncErrorEmits('Network timeout — retrying in 60s'),
  },
  {
    id: 'scope-upgrade',
    label: 'Sync: scope upgrade required',
    group: 'sync',
    componentFile: 'SyncStatus.tsx',
    invoke: {
      ...LOGGED_IN_INVOKE,
      ...connectedGDriveInvoke(),
      get_sync_status: {
        enabled: true,
        configured: true,
        provider: 'gdrive',
        lastSync: Math.floor(Date.now() / 1000) - 5 * 60,
        entriesPending: 0,
      },
      get_sync_scope_upgrade_required: true,
    },
    emitOnLoad: scopeUpgradeEmits(),
  },
  // --- Google Drive recovery / progressive disclosure visual scenarios ---
  {
    id: 'gdrive-settings-collapsed',
    label: 'Sync: connected (recovery wizard)',
    group: 'sync',
    componentFile: 'GoogleDriveSettings.tsx',
    invoke: {
      ...LOGGED_IN_INVOKE,
      ...connectedGDriveInvoke(),
      list_devices: makeConnectedDevices,
      refresh_devices_from_cloud: makeConnectedDevices,
      get_sync_status: CONNECTED_SYNC_STATUS,
      ...recoveryCommandInvoke(),
    },
    seedStores: seedGDriveSettings,
  },
  {
    id: 'gdrive-recovery-active',
    label: 'Sync: recovery in progress',
    group: 'sync',
    componentFile: 'GoogleDriveSettings.tsx',
    invoke: {
      ...LOGGED_IN_INVOKE,
      ...connectedGDriveInvoke(),
      list_devices: makeConnectedDevices,
      refresh_devices_from_cloud: makeConnectedDevices,
      get_sync_status: CONNECTED_SYNC_STATUS,
      ...recoveryCommandInvoke({
        // local_to_cloud at transfer is past fence → canCancelSafely false (backend).
        // canResume true while running so long resume steps can re-enter.
        get_sync_recovery_status: makeSyncRecoveryStatus({
          operation: 'local_to_cloud',
          phase: 'transfer',
          status: 'running',
          isActive: true,
          blocksNormalSync: true,
          canResume: true,
          canCancelSafely: false,
          nextStep: 'local_finalize',
          lastError: null,
          errorClass: null,
        }),
      }),
    },
    seedStores: seedGDriveSettings,
    emitOnLoad: () =>
      recoveryStatusEmits(
        makeSyncRecoveryStatus({
          operation: 'local_to_cloud',
          phase: 'transfer',
          status: 'running',
          isActive: true,
          blocksNormalSync: true,
          canResume: true,
          canCancelSafely: false,
          nextStep: 'local_finalize',
          errorClass: null,
        }),
      ),
  },
  {
    id: 'gdrive-sync-error-network',
    label: 'Sync: network error (no auto-expand)',
    group: 'sync',
    componentFile: 'GoogleDriveSettings.tsx',
    invoke: {
      ...LOGGED_IN_INVOKE,
      ...connectedGDriveInvoke(),
      list_devices: makeConnectedDevices,
      refresh_devices_from_cloud: makeConnectedDevices,
      get_sync_status: {
        enabled: true,
        configured: true,
        provider: 'gdrive',
        lastSync: null,
        entriesPending: 1,
      },
      ...recoveryCommandInvoke(),
    },
    seedStores: seedGDriveSettings,
    emitOnLoad: () => syncErrorEmits('Network timeout — retrying in 60s'),
  },
  // --- ai group ---
  {
    id: 'ai-connected',
    label: 'AI: connected',
    group: 'app',
    componentFile: 'TwoPanelLayout.tsx',
    invoke: {
      ...LOGGED_IN_INVOKE,

      // ── AI settings — all features on, Ollama local provider ────────────
      get_ai_settings: aiConnectedSettings,
      set_ai_feature_prompt: setAiConnectedFeaturePrompt,

      // ── AI providers — Ollama for generation + embedding; OpenAI-compat
      // image slot so Generate Image renders as enabled (not
      // disabled-with-tooltip "unsupported"). Ollama has no image model
      // in PROVIDER_PRESETS; a separate image slot matches real dual-slot use.
      get_ai_providers: {
        generation: {
          provider: 'ollama',
          endpoint: 'http://127.0.0.1:11434/v1',
          endpointClass: 'local',
          chatModel: 'qwen3.5:4b',
          hasApiKey: false,
        },
        image: {
          provider: 'openai',
          endpoint: 'https://api.openai.com/v1',
          endpointClass: 'remote',
          imageModel: 'gpt-image-1',
          hasApiKey: true,
        },
        embedding: {
          provider: 'ollama',
          endpoint: 'http://127.0.0.1:11434/v1',
          endpointClass: 'local',
          embeddingModel: 'nomic-embed-text',
          hasApiKey: false,
        },
      } satisfies AIProvidersConfig,

      // ── Embedding index (semantic search / RAG readiness) ─────────────────
      get_embedding_index_stats: {
        model_id: 'ollama:nomic-embed-text',
        indexed: entries.length,
        total: entries.length,
        pending: 0,
      },
      get_backfill_status: {
        running: false,
        model_id: 'ollama:nomic-embed-text',
        indexed: entries.length,
        total: entries.length,
      },

      // ── Chat sessions (paginated list) ────────────────────────────────────
      daily_chat_list_sessions_paged: (args: Record<string, unknown>) =>
        makePagedChatSessions(
          (args.page as number) ?? 1,
          typeof args.query === 'string' ? args.query : undefined,
        ),

      // ── Chat session detail (load on select) ──────────────────────────────
      daily_chat_load_session: loadChatSession,

      // In-memory create/save/load so chat→entry persist + reopen is honest.
      create_entry: createChatEntry,
      save_entry_content: saveCreatedEntryContent,
      get_entry: (args: Record<string, unknown>) =>
        getCreatedEntry(args.id as string) ??
        (LOGGED_IN_INVOKE.get_entry as (a: Record<string, unknown>) => Entry | null)(args),
      get_entry_content: (args: Record<string, unknown>) =>
        getCreatedEntryContent(args.id as string),
      list_all_entries_paged: withCreatedPaged(
        LOGGED_IN_INVOKE.list_all_entries_paged as (
          a: Record<string, unknown>,
        ) => PagedResult<Entry>,
      ),
      list_entries_paged: withCreatedPaged(
        LOGGED_IN_INVOKE.list_entries_paged as (a: Record<string, unknown>) => PagedResult<Entry>,
      ),

      // ── Chat session mutations — no-ops in preview ────────────────────────
      daily_chat_create_session: CHAT_SESSION_4_ID,
      daily_chat_create_session_from_ask: CHAT_SESSION_4_ID,
      daily_chat_delete_session: null,
      daily_chat_rename_session: null,
      daily_chat_generate_title: null,
      daily_chat_send_turn: null,
      cancel_suggestion: null,
      convert_chat_to_entry: convertChatToEntry,
      convert_chat_delta_to_entry: convertChatDeltaToEntry,
      daily_chat_mark_converted: markChatConverted,

      // Preview stub: resolve quickly so the Generate Image modal can
      // complete its happy path without a real provider.
      generate_inline_image: {
        mediaId: 'preview-ai-image',
        localPath: '/fake/media/preview-ai-image.jpg',
        insertionMode: 'attached',
      },
    },
  },
  // --- settings group ---
  createAppleJournalImportScenario(LOGGED_IN_INVOKE),
  {
    id: 'settings-security-no-pw',
    label: 'Security: no device password',
    group: 'settings',
    componentFile: 'EncryptionSettings.tsx',
    componentName: 'renderDevicePasswordPanel',
    invoke: {
      ...LOGGED_IN_INVOKE,
      get_encryption_mode: 'none',
      is_biometric_available: false,
      is_biometric_unlock_enabled: false,
      second_lock_status: false,
    },
    seedStores: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        settingsCategory: 'security',
        securityTab: 'device_password',
      })
    },
  },
  {
    id: 'settings-security-with-pw',
    label: 'Security: device password set',
    group: 'settings',
    componentFile: 'EncryptionSettings.tsx',
    componentName: 'renderDevicePasswordPanel',
    invoke: {
      ...LOGGED_IN_INVOKE,
      get_encryption_mode: 'password',
      is_encryption_initialized: true,
      is_biometric_available: true,
      is_biometric_unlock_enabled: false,
      second_lock_status: false,
    },
    seedStores: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        settingsCategory: 'security',
        securityTab: 'device_password',
      })
    },
  },
  {
    id: 'settings-security-second-invisible-lock-off',
    label: 'Security: second & invisible lock (off)',
    group: 'settings',
    // Tab hosts SecondLockSettings (separate file) when password mode is on.
    componentFile: 'EncryptionSettings.tsx',
    componentName: 'SecondLockSettings',
    invoke: {
      ...LOGGED_IN_INVOKE,
      get_encryption_mode: 'password',
      is_encryption_initialized: true,
      is_biometric_available: false,
      is_biometric_unlock_enabled: false,
      second_lock_status: false,
    },
    seedStores: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        settingsCategory: 'security',
        securityTab: 'second_lock',
      })
      // Turn "invisible lock off" by unlocking the session so invisible entries are visible
      useInvisibleLockStore.getState().unlockSession('vault-a')
    },
  },
  {
    id: 'settings-security-second-invisible-lock-on',
    label: 'Security: second & invisible lock (on)',
    group: 'settings',
    componentFile: 'EncryptionSettings.tsx',
    componentName: 'SecondLockSettings',
    invoke: {
      ...LOGGED_IN_INVOKE,
      get_encryption_mode: 'password',
      is_encryption_initialized: true,
      is_biometric_available: false,
      is_biometric_unlock_enabled: false,
      second_lock_status: true,
      get_setting: (args: Record<string, unknown>) => {
        const editorDefault = webGetSetting(args)
        if (editorDefault !== null) return editorDefault
        const key = args.key as string
        if (key === 'second_lock_show_existence') return 'false'
        if (key === 'second_lock_auto_lock_minutes') return '5'
        if (key === 'invisible_lock_auto_lock_minutes') return '5'
        return null
      },
    },
    seedStores: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        settingsCategory: 'security',
        securityTab: 'second_lock',
      })
      // Both locks are enabled, but the sessions are unlocked so every
      // second-locked and invisible fake entry is revealed (unlocked).
      useSecondLockStore.getState().setEnabled(true)
      useSecondLockStore.getState().unlockSession()
      useInvisibleLockStore.getState().unlockSession('vault-a')
    },
  },
  {
    id: 'settings-security-recovery',
    label: 'Security: recovery & keys',
    group: 'settings',
    componentFile: 'EncryptionSettings.tsx',
    componentName: 'renderRecoveryPanel',
    invoke: {
      ...LOGGED_IN_INVOKE,
      get_encryption_mode: 'password',
      is_encryption_initialized: true,
      is_biometric_available: false,
      is_biometric_unlock_enabled: false,
      second_lock_status: false,
    },
    seedStores: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        settingsCategory: 'security',
        securityTab: 'recovery_devices',
      })
    },
  },
]

export function getScenario(id: string): Scenario | undefined {
  return scenarios.find((s) => s.id === id)
}

export const defaultScenarioId = 'locked'
