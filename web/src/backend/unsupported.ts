import type {
  AIFullSettings,
  EmbedSyncDecisionSlotView,
  EmbedSyncSlot,
  EmbeddingSyncDecisionsResponse,
} from '../../../src/types/ai'

/** Rejection for any command the web build does not implement. */
export class WebUnsupportedError extends Error {
  readonly code = 'unsupported_on_web'
  readonly command: string

  constructor(command: string) {
    super(`unsupported_on_web: ${command}`)
    this.name = 'WebUnsupportedError'
    this.command = command
  }
}

type DefaultValue = unknown | ((args: Record<string, unknown>) => unknown)

const EMPTY_PAGE = { items: [], total: 0 }

function emptySlot(slot: EmbedSyncSlot): EmbedSyncDecisionSlotView {
  return {
    slot,
    state: 'none',
    reason: null,
    localModelId: null,
    peerModels: [],
    pendingUnits: 0,
    needsModal: false,
  }
}

const EMBEDDING_SYNC_DECISIONS: EmbeddingSyncDecisionsResponse = {
  slots: [emptySlot('entry'), emptySlot('memory')],
  needsModal: false,
}

/** Every AI feature flag off, no provider configured (re-implemented from the mockup defaults). */
const AI_SETTINGS_OFF = {
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
  userMemoryEnabled: false,
  personaEnabled: false,
  mcpServerEnabled: false,
  mcpDefaultJournalId: null,
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
} satisfies AIFullSettings

/**
 * Read-only commands the UI fires on mount. They resolve to a safe "unavailable"
 * value (empty list, null, false, 0, empty object) shaped like the real result in
 * `src/lib/tauri.ts`, so the app boots. Phases 9-16 move the ones the web really
 * serves into the router handler table; the coverage test requires removing them here.
 */
export const QUERY_DEFAULTS: Record<string, DefaultValue> = {
  // Boot and vault state (startup/encryption mode, device id: served by commands/auth.ts).
  app_version: null,
  check_for_update: null,
  get_pending_first_time_setup: null,
  is_biometric_available: false,
  is_biometric_unlock_enabled: false,
  second_lock_status: false,
  // Needs the whole history, which the web never loads at once (the read commands are in commands/).
  get_streak: { current_streak: 0, longest_streak: 0, last_entry_date: null },
  // Media.
  list_media_for_entry: [],
  list_all_media_paged: EMPTY_PAGE,
  get_media_upload_limits: { photoBytes: -1, videoBytes: -1 },
  // Sync and devices.
  get_sync_catchup_status: { complete: true, pulled: 0, total: 0 },
  get_sync_scope_upgrade_required: false,
  get_sync_recovery_status: null,
  icloud_availability: { available: false, path: '' },
  list_devices: [],
  get_pending_rotation_recovery: null,
  get_force_re_pair_status: null,
  // TODO(later): see docs/LATER.md - dashboard and stats
  stats_entries_over_time: [],
  stats_mood_histogram: [],
  stats_mood_trend: [],
  stats_emotion_trend: [],
  stats_tag_frequency: [],
  stats_writing_volume: [],
  stats_writing_hours: [],
  stats_streak_calendar: [],
  stats_location_density: [],
  // TODO(later): see docs/LATER.md - maps, geocoding, weather
  list_map_pins: [],
  list_location_aliases: [],
  get_location_alias: null,
  find_nearby_aliases: [],
  // TODO(later): see docs/LATER.md - basemap
  basemap_status: { status: 'not_downloaded', path: null, size_bytes: null },
  // TODO(later): see docs/LATER.md - reminders and notifications
  list_reminders: [],
  // TODO(later): see docs/LATER.md - version history
  list_entry_versions: [],
  get_version_retention_days: 7,
  // TODO(later): see docs/LATER.md - font downloads
  get_font_cache_stats: { usedBytes: 0, fontCount: 0 },
  search_google_fonts_catalog: [],
  get_google_fonts_catalog_meta: { fetchedAt: null, count: 0 },
  // TODO(later): see docs/LATER.md - AI (generation, chat, memory and persona, embeddings, semantic search)
  is_ai_supported: false,
  get_ai_settings: AI_SETTINGS_OFF,
  get_ai_providers: { generation: null, image: null, embedding: null },
  get_ai_provider_credentials: [],
  semantic_search: [],
  get_entry_highlights: null,
  get_period_review: null,
  get_cached_theme_insights: null,
  get_backfill_status: { running: false, model_id: null, indexed: 0, total: 0 },
  get_embedding_index_stats: { model_id: null, indexed: 0, total: 0, pending: 0 },
  get_embedding_job_stats: {
    pending: 0,
    in_progress: 0,
    indexed: 0,
    skipped: 0,
    error: 0,
    paused: 0,
  },
  get_embedding_sync_decisions: EMBEDDING_SYNC_DECISIONS,
  get_background_indexing_settings: { enabled: false, hostedConsentAt: null, allowed: false },
  list_memory_items: [],
  get_persona: {
    answersJson: '',
    traitsText: '',
    styleText: '',
    enabled: false,
    userEdited: false,
    generatedAt: null,
    updatedAt: 0,
  },
  list_ai_audit_log: [],
  get_ai_audit_retention_days: 90,
  // TODO(later): see docs/LATER.md - on-device LLM
  list_on_device_models: [],
  get_on_device_model_state: { status: 'not_downloaded' },
  list_on_device_llm_models: [],
  get_on_device_llm_server_status: { state: 'stopped' },
  on_device_llm_binary_status: { installed: false, size_bytes: 0 },
  // TODO(later): see docs/LATER.md - daily chats
  daily_chat_list_sessions_paged: EMPTY_PAGE,
  chat_session_for_entry: null,
  chat_search_attachable_entries: [],
  chat_count_entries_in_range: { entryCount: 0, totalBytes: 0 },
  chat_rag_preflight: {
    estimatedBytes: 0,
    totalBytes: 0,
    entriesIncluded: 0,
    entriesTotal: 0,
    trimmed: false,
    needsConfirm: false,
    blocked: false,
  },
  // TODO(later): see docs/LATER.md - MCP
  mcp_status: { running: false, socketPath: '', binaryPath: '' },
  // TODO(later): see docs/LATER.md - updater and desktop shell (dev-only seed data)
  seed_demo_status: { applied: false },
}

/**
 * Commands that have no safe "unavailable" value: they reject with
 * `WebUnsupportedError`. Each group is a deferred area from the plan's
 * "Not Building (v1)" list (or a command a later phase will implement).
 */
export const ACTION_UNSUPPORTED: readonly string[] = [
  // TODO(later): see docs/LATER.md - AI (generation, chat, memory and persona, embeddings, semantic search, on-device models)
  'accept_ai_bulk_context',
  'accept_ai_privacy',
  'accept_background_indexing_hosted_consent',
  'ai_v2_migrate',
  'build_persona',
  'cancel_on_device_llm_download',
  'cancel_on_device_model_download',
  'cancel_suggestion',
  'check_cli_provider_health',
  'clear_ai_audit_log',
  'clear_entry_highlights',
  'consolidate_memories_command',
  'continue_writing',
  'delete_memory_item',
  'delete_on_device_llm_binary',
  'delete_on_device_llm_model',
  'download_on_device_llm_model',
  'forget_ai_embedding_provider',
  'forget_ai_generation_provider',
  'forget_ai_image_provider',
  'forget_ai_provider_credential',
  'generate_entry_highlights',
  'generate_inline_image',
  'generate_period_review',
  'generate_theme_insights',
  'go_deeper',
  'pause_backfill',
  'remove_on_device_model',
  'resolve_embedding_sync_decision',
  'rewrite_selection',
  'scan_memories',
  'set_ai_audit_retention_days',
  'set_ai_embedding_provider',
  'set_ai_feature',
  'set_ai_feature_prompt',
  'set_ai_generation_provider',
  'set_ai_image_provider',
  'set_ai_provider_credential',
  'set_ai_response_language',
  'set_background_indexing_enabled',
  'set_emotion_suggestion_language',
  'set_memory_allow_hosted',
  'set_memory_embed_provider',
  'set_memory_enabled',
  'set_memory_gen_provider',
  'set_persona_enabled',
  'start_backfill',
  'start_on_device_model_download',
  'suggest_emotion',
  'suggest_tags',
  'suggest_title',
  'summarise_entries',
  'summarise_entry',
  'summarize_ai_usage',
  'test_ai_embedding_provider',
  'test_ai_generation_provider',
  'test_ai_provider_credential',
  'update_memory_item_text',
  'write_persona_answers',
  'write_persona_user_edit',
  // TODO(later): see docs/LATER.md - Daily chats
  'convert_chat_delta_to_entry',
  'convert_chat_to_entry',
  'daily_chat_delete_session',
  'daily_chat_generate_title',
  'daily_chat_load_session',
  'daily_chat_mark_converted',
  'daily_chat_rename_session',
  'daily_chat_send_turn',
  'daily_chat_set_session_pinned',
  'set_daily_chat_ai_title',
  'set_daily_chat_preferences',
  // TODO(later): see docs/LATER.md - MCP
  'set_mcp_default_journal',
  // TODO(later): see docs/LATER.md - Dashboard and stats export
  'export_stats_file',
  // TODO(later): see docs/LATER.md - Maps, geocoding, weather, location aliases, EXIF
  'collect_entry_exif_dates',
  'collect_entry_exif_locations',
  'create_location_alias',
  'delete_location_alias',
  'fetch_weather',
  'geocode_check',
  'geocode_resolve',
  'geocode_reverse',
  'geocode_search',
  'get_mapkit_token',
  'read_image_exif',
  'update_entry_location',
  'update_entry_weather',
  'update_location_alias',
  // TODO(later): see docs/LATER.md - Basemap
  'cancel_basemap_download',
  'delete_basemap',
  'download_basemap',
  'read_basemap_range',
  // TODO(later): see docs/LATER.md - Reminders and notifications
  'create_reminder',
  'delete_reminder',
  'update_reminder',
  // TODO(later): see docs/LATER.md - Import and export
  'export_data',
  'export_media_to_path',
  'import_data',
  'preview_apple_journal_import',
  'write_apple_journal_import_report',
  'write_markdown_zip',
  // TODO(later): see docs/LATER.md - Recovery sheet
  'decode_recovery_qr_file',
  'render_recovery_sheet',
  // TODO(later): see docs/LATER.md - Key rotation and recovery phrase
  'confirm_rotation_recovery_saved',
  'reset_recovery_phrase',
  'resume_rotation',
  'rotate_master_key',
  // TODO(later): see docs/LATER.md - Force re-pair, device management and Drive recovery flows
  'clear_sync_scope_upgrade_required',
  'complete_force_re_pair',
  'gdrive_begin_cloud_authoritative_staging',
  'gdrive_cancel_sync_recovery',
  'gdrive_commit_cloud_authoritative_restore',
  'gdrive_finalize_local_authoritative_recovery',
  'gdrive_materialize_cloud_authoritative_staging',
  'gdrive_preflight_local_authoritative_recovery',
  'gdrive_rebuild_cloud_from_local',
  'gdrive_resume_sync_recovery',
  'gdrive_wipe_cloud',
  'recheck_force_re_pair',
  'refresh_devices_from_cloud',
  'remove_device',
  'rename_device',
  'revoke_device',
  'sync_repair_from_this_device',
  'sync_reset_local_state',
  // TODO(later): see docs/LATER.md - Second lock and invisible vault
  'change_invisible_vault_password',
  'change_second_lock_password',
  'disable_second_lock',
  'open_or_create_invisible_vault',
  'remove_empty_invisible_vaults',
  'set_entry_invisible',
  'set_entry_locked',
  'set_journal_invisible',
  'set_journal_locked',
  'set_second_lock_password',
  'verify_second_lock_password',
  // TODO(later): see docs/LATER.md - Version history
  'get_entry_version_content',
  'set_version_retention_days',
  'snapshot_entry_version',
  // TODO(later): see docs/LATER.md - Journal and tag creation / management
  'add_tag_to_entry',
  'create_journal',
  'create_tag',
  'delete_journal',
  'delete_tag',
  'remove_tag_from_entry',
  'update_journal',
  'update_tag',
  // TODO(later): see docs/LATER.md - Template editing
  'create_template',
  'delete_template',
  'update_template',
  // TODO(later): see docs/LATER.md - Updater and desktop shell
  'install_update',
  'restart_app',
  'seed_demo_data',
  'uninstall_app',
  'uninstall_preview',
  // TODO(later): see docs/LATER.md - Font downloads and font cache
  'clear_font_cache',
  'download_google_font',
  'refresh_google_fonts_catalog',
  // TODO(later): see docs/LATER.md - Audio recording
  'discard_audio_memo',
  'get_recording_levels',
  'read_audio_memo_bytes',
  'save_audio_memo',
  'start_recording',
  'stop_recording',
  // TODO(later): see docs/LATER.md - Entry delete
  'soft_delete_entry',
  // TODO(later): see docs/LATER.md - Vault creation, password and biometric management (companion app: the vault is created on desktop)
  'begin_first_time_setup',
  'cancel_first_time_setup',
  'change_password',
  'confirm_first_time_setup',
  'disable_biometric_unlock',
  'enable_biometric_unlock',
  'recover_with_passphrase',
  'unlock_with_biometric',
  'verify_password',
  // Entry and media writes and Drive connection: Phases 9-16 move these into the handler table (registerHandlers).
  'cloud_folder_connect',
  'create_entry',
  'delete_media',
  'ensure_video_thumbnail',
  'gdrive_disconnect',
  'gdrive_refresh_storage_quota',
  'gdrive_test_connection',
  'mark_entry_date_user_edited',
  'move_entry_to_journal',
  'pick_files_to_attach',
  'pick_image',
  'pick_images_from_library',
  'pick_video',
  'pick_videos_from_library',
  'push_entry',
  'recalculate_streak',
  'save_entry_content',
  'save_pasted_image',
  'set_media_upload_limits',
  'set_sync_enabled',
  'set_sync_settings',
  'toggle_favorite',
  'update_entry',
  'update_entry_date',
  'update_entry_emotion',
  'update_media_insertion_mode',
]

const ACTION_SET: ReadonlySet<string> = new Set(ACTION_UNSUPPORTED)

/** Fallback for any command missing from the router handler table. */
export async function unsupported(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  if (Object.hasOwn(QUERY_DEFAULTS, cmd)) {
    const value = QUERY_DEFAULTS[cmd]
    return typeof value === 'function'
      ? (value as (a: Record<string, unknown>) => unknown)(args)
      : value
  }
  if (!ACTION_SET.has(cmd))
    console.warn(`[web] invoke '${cmd}' is not classified in unsupported.ts`)
  throw new WebUnsupportedError(cmd)
}
