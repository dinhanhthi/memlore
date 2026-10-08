import { describe, expect, it, vi } from 'vitest'

// Web build: every capability except `writes` is off, so the palette must not
// offer commands that route to unsupported backend calls or to settings
// surfaces the web build hides. `writes` stays true — supported web writes
// (create entry, edit, tags) must remain reachable. Every flag is set
// explicitly: spreading the all-true desktop capabilities would let
// assertions pass vacuously.
vi.mock('../platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform')>()
  return {
    ...actual,
    isWeb: true,
    capabilities: {
      ...actual.capabilities,
      windowChrome: false,
      biometric: false,
      icloud: false,
      ai: false,
      dashboard: false,
      stats: false,
      maps: false,
      mapView: false,
      chat: false,
      reminders: false,
      importExport: false,
      versions: false,
      secondLock: false,
      onDeviceModels: false,
      updater: false,
      gallery: false,
      lookback: false,
      taxonomyEdits: false,
      deleteEntries: false,
      trash: false,
      audioRecording: false,
      fileAttachments: false,
      fontDownloads: false,
      syncAdmin: false,
      vaultAdmin: false,
      writes: true,
    },
  }
})

import { getCommands } from './registry'

// The 14 AI feature toggles generated from the TOGGLE_SETTINGS feature list.
const AI_FEATURE_IDS = [
  'semantic_search',
  'emotion_suggestions',
  'chat_rag',
  'title_suggestions',
  'entry_highlights',
  'go_deeper',
  'continue_writing',
  'daily_chat',
  'image_generation',
  'multi_entry_summary',
  'tag_suggestions',
  'periodic_review',
  'theme_insights',
  'dashboard_insights',
] as const

// Every command id that must be hidden on web — including generated
// `settings_value.*` enable/disable variants and the deep-link fallback rows
// that appear when a toggle's `available()` is false.
const WEB_HIDDEN_IDS: readonly string[] = [
  // Pages
  'page.dashboard',
  'page.stats',
  'page.onthisday',
  'page.media',
  'page.map',
  'page.chat',
  // Actions
  'action.new_journal',
  'action.export_data',
  'action.import_data',
  'action.unlock_second_lock',
  'action.lock_second_lock',
  'action.unlock_invisible',
  'action.lock_invisible',
  // Settings categories gated by isSettingsCategoryAvailable
  'settings.security',
  'settings.location',
  'settings.reminders',
  'settings.ai',
  'settings.data',
  // Sub-tabs of hidden categories
  'settings.security_device_password',
  'settings.security_second_lock',
  'settings.security_recovery_devices',
  'settings.security_invisible_lock',
  'settings.location_geocoding',
  'settings.location_saved',
  'settings.ai_models',
  'settings.ai_features',
  'settings.ai_general',
  'settings.ai_providers',
  'settings.ai_memories',
  'settings.ai_persona',
  'settings.data_import',
  'settings.data_export',
  'settings.data_downloads',
  // Sync administration (syncAdmin): sub-tabs, interval, compression, limits
  'settings.sync_devices',
  'settings.sync_schedule',
  'settings.sync_interval',
  'settings.compression_mode',
  'settings.upload_limits',
  // Location deep links (maps)
  'settings.geocoding_provider',
  'settings.geocoding_api_key',
  'settings.saved_locations',
  // Security deep links
  'settings.biometric',
  'settings.change_password',
  'settings.second_lock_auto_lock',
  'settings.invisible_lock_auto_lock',
  // AI deep links
  'settings.ai_response_language',
  'settings.ai_emotion_language',
  'settings.ai_daily_chat_persona',
  'settings.ai_memory_include_protected',
  'settings.ai_memory_model_gen',
  'settings.ai_memory_model_embed',
  // Toggle value commands + deep-link fallback rows where the toggle has one
  'settings_value.start_at_login.enable',
  'settings_value.start_at_login.disable',
  'settings_value.sync_enabled.enable',
  'settings_value.sync_enabled.disable',
  'settings_value.sync_enabled',
  'settings_value.sync_on_save.enable',
  'settings_value.sync_on_save.disable',
  'settings_value.sync_on_save',
  'settings_value.sync_on_launch.enable',
  'settings_value.sync_on_launch.disable',
  'settings_value.sync_on_launch',
  'settings_value.default_location_enabled.enable',
  'settings_value.default_location_enabled.disable',
  'settings_value.second_lock_show_existence.enable',
  'settings_value.second_lock_show_existence.disable',
  'settings_value.chat_memory.enable',
  'settings_value.chat_memory.disable',
  'settings_value.daily_chat_ai_title.enable',
  'settings_value.daily_chat_ai_title.disable',
  'settings_value.show_message_meta.enable',
  'settings_value.show_message_meta.disable',
  'settings_value.user_memory_master.enable',
  'settings_value.user_memory_master.disable',
  'settings_value.persona_enabled.enable',
  'settings_value.persona_enabled.disable',
  'settings_value.persona_enabled',
  // Pills
  'settings_value.version_retention.3',
  'settings_value.version_retention.7',
  'settings_value.version_retention.15',
  'settings_value.default_search_mode.keyword',
  'settings_value.default_search_mode.meaning',
  'settings_value.default_search_mode',
  'settings_value.media_view_mode.full',
  'settings_value.media_view_mode.panel',
  // All AI feature toggles + their deep-link fallback rows
  ...AI_FEATURE_IDS.flatMap((f) => [
    `settings_value.${f}.enable`,
    `settings_value.${f}.disable`,
    `settings_value.${f}`,
  ]),
]

// Commands that must stay reachable on web.
const WEB_VISIBLE_IDS: readonly string[] = [
  'page.entries',
  'page.calendar',
  'page.tags',
  'page.settings',
  'page.about',
  'action.new_entry',
  'action.sync_now',
  'action.open_search',
  'action.toggle_sidebar',
  // Settings categories that have web-supported content
  'settings.general',
  'settings.editor',
  'settings.appearance',
  'settings.sync',
  'settings.media',
  'settings.journals',
  'settings.templates',
  // Sub-tabs of visible categories (incl. sync gdrive — connect is supported)
  'settings.editor_general',
  'settings.editor_layout',
  'settings.editor_font',
  'settings.appearance_theme',
  'settings.appearance_display',
  'settings.sync_gdrive',
  'settings.templates_custom',
  'settings.templates_builtin',
  // Ungated deep links (media cache settings are supported web writes)
  'settings.accent_color',
  'settings.cache_limit',
  'settings.editor_font_family',
  'settings.editor_font_size',
  'settings.editor_font_contrast',
]

function availableIds(): string[] {
  return getCommands()
    .filter((c) => c.available?.() ?? true)
    .map((c) => c.id)
}

describe('command palette on web', () => {
  it('hides every web-unsupported command incl. toggle and deep-link variants', () => {
    const available = availableIds()
    for (const id of WEB_HIDDEN_IDS) {
      expect(available, `expected ${id} to be hidden on web`).not.toContain(id)
    }
  })

  it('keeps web-supported navigation, action and settings commands', () => {
    const available = availableIds()
    for (const id of WEB_VISIBLE_IDS) {
      expect(available, `expected ${id} to stay available on web`).toContain(id)
    }
  })
})
