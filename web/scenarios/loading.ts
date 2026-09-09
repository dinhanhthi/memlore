import type { Scenario } from './types'

/**
 * A command result that never settles. `route()` awaits whatever an override
 * returns, so a never-resolving promise freezes that command in its pending
 * state forever — the calling hook keeps `isLoading === true` and the page
 * stays on its loading placeholder for as long as you want to look at it.
 */
export const pending = (): Promise<never> => new Promise<never>(() => {})

/**
 * Every page-level data command, stalled. Spread AFTER `LOGGED_IN_INVOKE` so
 * only these keys are overridden.
 *
 * This is deliberately an allowlist, not "stall everything": the boot-path
 * commands (auth, settings, sync status, the AI provider/embedding snapshots
 * documented in `web/mocks/invokeRouter.ts`) are dereferenced on mount, and a
 * pending promise leaves `data === undefined` — which crashes the preview the
 * same way a missing mock does. Only the surfaces that own a loading state are
 * listed here.
 */
export const LOADING_INVOKE: NonNullable<Scenario['invoke']> = {
  // ── Entries list (all four paged surfaces the list can be showing) ─────
  list_all_entries_paged: pending,
  list_entries_paged: pending,
  list_favorite_entries_paged: pending,
  list_entries_by_tag_paged: pending,

  // ── Calendar ──────────────────────────────────────────────────────────
  list_entry_dates: pending,
  list_entries_for_date_range: pending,
  get_emotion_by_date: pending,
  get_entry_frequency: pending,

  // ── Tags ──────────────────────────────────────────────────────────────
  list_tags: pending,
  get_tags_with_counts: pending,

  // ── On This Day ───────────────────────────────────────────────────────
  list_on_this_day: pending,

  // ── Media gallery (2-panel grid + full-page) ──────────────────────────
  list_all_media_paged: pending,

  // ── Map ───────────────────────────────────────────────────────────────
  list_map_pins: pending,

  // ── Statistics (charts tab + AI usage tab + AI audit tab) ─────────────
  stats_entries_over_time: pending,
  stats_mood_histogram: pending,
  stats_mood_trend: pending,
  stats_tag_frequency: pending,
  stats_writing_volume: pending,
  stats_streak_calendar: pending,
  stats_location_density: pending,
  get_streak: pending,
  summarize_ai_usage: pending,
  list_ai_audit_log: pending,

  // ── Daily Chat (session list) ─────────────────────────────────────────
  daily_chat_list_sessions_paged: pending,
}
