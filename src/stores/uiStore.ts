import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  coerceCornerRadius,
  coerceDesignSystem,
  coerceSurfaceStyle,
  DEFAULT_CORNER_RADIUS,
  DEFAULT_DESIGN_SYSTEM,
  DEFAULT_SURFACE_STYLE,
  type CornerRadius,
  type DesignSystem,
  type SurfaceStyle,
} from '../lib/designSystem'
import { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES } from '../lib/i18n'
import type { LanguagePreference } from '../lib/i18n'
import type { LockFilter, SortOrder, TimeRange } from '../lib/entryFilterSort'

export type Theme = 'light' | 'dark'

export const DEFAULT_THEME: Theme = 'dark'

export function coerceTheme(value: unknown): Theme {
  return value === 'light' || value === 'dark' ? value : DEFAULT_THEME
}

export type TimeFormat = '24h' | '12h'

/**
 * Interface font-size multiplier. Scales body/UI text tokens and the two
 * sidebars' icons via the runtime `--ui-font-scale` CSS variable (see
 * `useUiFontScale`). Headings (`text-lg`+ tokens) are intentionally frozen.
 */
export type UiFontScale = 1 | 1.05 | 1.1

/**
 * Slot key the entry list filter row uses to store its state. Tags all
 * share one slot — per-tag state would bloat the store and complicate
 * cleanup when a tag is deleted; revisit if users ask for it. Not
 * persisted: state resets on app restart by design (advisor #3).
 */
export type EntryListViewKey = 'all' | 'tags' | 'onthisday'

export interface EntryListFilterState {
  range: TimeRange
  sort: SortOrder
  lockFilter: LockFilter
  /** Journal scope for this view. `null` = all journals. Scoped per-view so
   * picking a journal on one page (e.g. All Entries) never leaks into another
   * (On This Day) — mirrors range/sort/lockFilter isolation. */
  journalId: string | null
}

const DEFAULT_FILTER_STATE: EntryListFilterState = {
  range: { kind: 'all' },
  sort: 'newest',
  lockFilter: 'all',
  journalId: null,
}

export type ActiveView =
  // landing view; see docs/plans/2026-09-03-dashboard-view
  | 'dashboard'
  | 'entries'
  | 'tags'
  | 'calendar'
  | 'search'
  // 'templates' was removed in favor of Settings → Templates. The
  // TemplatePicker modal (Cmd+T / footer Aa menu) still ships templates
  // inline when starting a new entry.
  | 'settings'
  // Coming-soon stubs (decision #13) — sidebar items are visible + clickable
  // from Chunk D; actual placeholder pages land in Chunk E.
  | 'onthisday'
  | 'media'
  | 'map'
  | 'stats'
  // Phase 6 v2 R9 — Daily Chat. Conditionally surfaced in the
  // sidebar (gated by `ai_daily_chat_enabled`); toggling OFF hides
  // the nav item but leaves the route navigable so a stale
  // activeView=chat in persisted state is still reachable until the
  // user explicitly navigates away.
  | 'chat'
  | 'about'

export type SettingsCategory =
  | 'general'
  | 'editor'
  | 'appearance'
  | 'security'
  | 'sync'
  | 'media'
  | 'location'
  | 'journals'
  | 'templates'
  | 'reminders'
  | 'ai'
  | 'data'

// Sub-tab IDs for settings categories that own an internal horizontal
// tablist. Storage lives on the per-app-tab `Tab` in tabStore so each
// app tab keeps independent settings navigation while surviving unmounts
// (e.g. when the user switches to another app tab whose `activeView`
// isn't 'settings').
export type SecurityTab = 'device_password' | 'second_lock' | 'invisible_lock' | 'recovery_devices'
export type LocationTab = 'geocoding' | 'saved'
/** `'chat'` is the merged "Models" tab — it absorbed the former `'embed'` tab,
 *  which rehydrate migrates rather than discards. */
export type AITab = 'general' | 'providers' | 'chat' | 'features' | 'memories' | 'persona'
export type TemplatesTab = 'custom' | 'builtin'
export type DataTab = 'import' | 'export' | 'downloads' | 'demo'
export type EditorTab = 'font' | 'general' | 'layout'
export type SyncTab = 'gdrive' | 'devices' | 'schedule'
export type AppearanceTab = 'theme' | 'display' | 'layout'

/**
 * Statistics page horizontal tab. Storage lives on the per-app-tab `Tab` in
 * tabStore so each app tab keeps independent stats navigation while surviving
 * unmounts (e.g. when the user switches to another app tab whose `activeView`
 * isn't 'stats'). Mirrors the settings sub-tab pattern.
 */
export type StatsTab = 'charts' | 'insights' | 'reviews' | 'usage' | 'audit'

/** Valid Settings → Data tabs. `demo` is DEV-only. */
export function validDataTabs(isDev: boolean = import.meta.env.DEV): readonly DataTab[] {
  return isDev
    ? (['import', 'export', 'downloads', 'demo'] as const)
    : (['import', 'export', 'downloads'] as const)
}

/** Coerce a persisted/unknown tab id to a valid DataTab for the current build. */
export function coerceDataTab(tab: string, isDev: boolean = import.meta.env.DEV): DataTab {
  const valid = validDataTabs(isDev)
  return (valid as readonly string[]).includes(tab) ? (tab as DataTab) : 'import'
}

interface UiState {
  sidebarCollapsed: boolean
  theme: Theme
  /**
   * Active design system. Persisted next to `theme` in localStorage
   * (`memlore-ui`) so it is readable before unlock — the lock screen
   * runs against an in-memory placeholder DB. Deliberately not a
   * backend setting and not synced.
   */
  designSystem: DesignSystem
  /**
   * Dark-canvas surface (`deep` / `soft` / `lumen`). Dual-written into
   * `memlore-ui` so boot + lock screen can read it before SQLCipher
   * unlock. Orthogonal to `designSystem`.
   */
  surfaceStyle: SurfaceStyle
  /**
   * Clean-only corner-radius scale (`low` / `medium` / `high`). Dual-written
   * into `memlore-ui` so boot + lock screen can read it before SQLCipher
   * unlock. Deliberately not a backend setting and not synced.
   */
  cornerRadius: CornerRadius
  searchOverlayOpen: boolean
  commandPaletteOpen: boolean
  newJournalModalOpen: boolean
  templatePickerOpen: boolean
  /**
   * Sidecar panel for the general "How AI works in Memlore" overview
   * (privacy, providers, feature families, embeddings at a high level).
   * Primary entry: "?" next to the AI Settings page title. Not persisted —
   * transient UI, like `searchOverlayOpen`/`commandPaletteOpen`.
   */
  embeddingExplainerOpen: boolean
  reducedMotion: boolean
  disableGradientPrimary: boolean
  logoFollowsCursor: boolean
  uiFontScale: UiFontScale
  /**
   * Items-per-page preference for the Media Gallery. Persisted so the choice
   * survives view/tab switches and app restarts. Read by `useAllMedia`, which
   * passes it down to the backend page fetch so the gallery can serve any
   * page size the user picks from the header dropdown.
   */
  mediaPageSize: number
  timeFormat: TimeFormat
  /**
   * Current UI language preference. Persisted to localStorage (this store's
   * `memlore-ui` key) — never written to the SQLite `settings` table and
   * never synced. Interface language is a per-device preference: a user on
   * a new machine re-picks it rather than inheriting it from synced data.
   * `i18n.ts` reads the persisted value directly via `readPersistedLanguage()`
   * at startup (before this store hydrates); `LanguageSelector` updates it
   * via `setUiLanguage`.
   */
  uiLanguage: LanguagePreference
  /**
   * Per-view filter/sort state for the entry list filter row. Keyed by
   * `EntryListViewKey`; non-persisted (lives in memory only). Default
   * comes from `DEFAULT_FILTER_STATE` when a key has not been touched.
   */
  entryListFilters: Partial<Record<EntryListViewKey, EntryListFilterState>>
  /**
   * Recovery phrase from a just-completed master-key rotation. Kept at the
   * store level (not local useState in EncryptionSettings) so the reveal modal
   * survives Settings-subtree unmounts (e.g. switching settings category or
   * closing the Settings tab). Cleared only when the user confirms they saved
   * the phrase. NOT persisted — secrets must not land in localStorage.
   */
  pendingRotationPhrase: string | null

  /**
   * Whether the pending reveal is a **reset** (Flow G — new master + NEW
   * phrase, old words dead, this is the only copy) vs a plain **rotate** (phrase
   * unchanged). Drives the reveal modal's copy: showing the rotate-only "phrase
   * unchanged" text on a reset is a data-loss trap. Defaults to rotate.
   */
  pendingRotationRevealIsReset: boolean

  /**
   * Shared cross-action lock for slow master-key rotations (revoke, reset,
   * rotate). The backend serialises these behind a single sync guard — only
   * one can run at a time — so while one is in flight every rotation-class
   * button in the Recovery & keys tab disables. Set true when a background
   * rotation starts, false when it settles (success OR error). NOT persisted:
   * a stuck-true value in localStorage would permanently disable the actions.
   */
  rotationBusy: boolean

  /**
   * Cross-UI lock for device rename background work (DB write + optional
   * Google Drive slot re-upload for the current device). Set true when a
   * rename starts, false when it settles (success OR error). Surfaces a
   * footer indicator and disables Devices-panel actions while in flight.
   * NOT persisted: a stuck-true value in localStorage would permanently
   * disable rename/revoke/refresh.
   */
  deviceRenameBusy: boolean

  /**
   * Cross-UI signal for a device removal running in the background. The
   * secure-wizard remove flow is non-blocking — the backend may queue behind
   * an in-flight sync for minutes and the user may close the modal — so the
   * footer surfaces this as a persistent "working" indicator until the call
   * settles (success OR error). NOT persisted: a stuck-true value in
   * localStorage would show a phantom removal forever.
   */
  deviceRemovalBusy: boolean

  /**
   * Last settled device-removal result. Written by `useWizardRemove.run()`
   * so Settings → Sync → Devices can show a dismissible notice after the
   * wizard unmounts (including the 600 s `acquire_waiting` timeout).
   * NOT persisted: a leftover outcome must not reappear after restart.
   */
  deviceRemovalOutcome: 'ok' | 'error' | null

  /**
   * Cross-tab "open this provider's accordion" request for the AI Settings
   * Providers tab (Phase 3+). Other tabs/flows (e.g. a feature tab's "fix
   * this provider" link) set this to a preset id; `ProvidersTab` consumes it
   * on mount/update by adding the id to its own open-accordion set, then
   * immediately calls `clearPendingOpenPresetId()` so the request doesn't
   * re-fire on the next render. NOT persisted: a stuck value in localStorage
   * would force-open an accordion on every future visit to the tab.
   */
  pendingOpenPresetId: string | null

  /**
   * Preset ids the user has explicitly added as a section on the AI
   * Settings → Providers tab (T3.7 flat redesign — no more accordions over
   * all 17 presets). The tab's shown set is `addedProviders ∪ { presets
   * `providerIsConfigured` already reports as configured }` — the union is
   * a safety property so a preset with a stored credential never becomes
   * invisible. Persisted: this is a deliberate, per-device "which providers
   * do I care about" list, not transient UI state.
   */
  addedProviders: string[]

  toggleSidebar: () => void
  setSidebarCollapsed: (collapsed: boolean) => void
  setTheme: (theme: Theme) => void
  setDesignSystem: (ds: DesignSystem) => void
  /** Persist-only mirror. DOM class application lives in the theme hook. */
  setSurfaceStyle: (s: SurfaceStyle) => void
  /** Persist-only; DOM class application lives in the design-system hook. */
  setCornerRadius: (r: CornerRadius) => void
  setNewJournalModalOpen: (open: boolean) => void
  setTemplatePickerOpen: (open: boolean) => void
  setEmbeddingExplainerOpen: (open: boolean) => void
  /**
   * Toggles theme between `light` and `dark`. Bound to the title-bar
   * Sun/Moon button and the command-palette theme actions.
   */
  toggleTheme: () => void
  setSearchOverlayOpen: (open: boolean) => void
  toggleSearchOverlay: () => void
  setCommandPaletteOpen: (open: boolean) => void
  toggleCommandPalette: () => void
  setReducedMotion: (v: boolean) => void
  toggleReducedMotion: () => void
  setDisableGradientPrimary: (v: boolean) => void
  setLogoFollowsCursor: (v: boolean) => void
  setUiFontScale: (scale: UiFontScale) => void
  setMediaPageSize: (size: number) => void
  setUiLanguage: (lang: LanguagePreference) => void
  setTimeFormat: (format: TimeFormat) => void
  setEntryListRange: (view: EntryListViewKey, range: TimeRange) => void
  setEntryListSort: (view: EntryListViewKey, sort: SortOrder) => void
  setEntryListLockFilter: (view: EntryListViewKey, lockFilter: LockFilter) => void
  setEntryListJournalId: (view: EntryListViewKey, journalId: string | null) => void
  setPendingRotationPhrase: (phrase: string | null, isReset?: boolean) => void
  setRotationBusy: (busy: boolean) => void
  setDeviceRenameBusy: (busy: boolean) => void
  setDeviceRemovalBusy: (busy: boolean) => void
  setDeviceRemovalOutcome: (outcome: 'ok' | 'error' | null) => void
  setPendingOpenPresetId: (presetId: string) => void
  clearPendingOpenPresetId: () => void
  /** Appends `presetId` to `addedProviders` if not already present
   *  (idempotent — a redundant add, e.g. from the cross-tab
   *  `pendingOpenPresetId` handoff on an already-added preset, is a no-op). */
  addProvider: (presetId: string) => void
  removeProvider: (presetId: string) => void
}

export type { LockFilter } from '../lib/entryFilterSort'

export function getEntryListFilter(
  state: { entryListFilters: Partial<Record<EntryListViewKey, EntryListFilterState>> },
  view: EntryListViewKey,
): EntryListFilterState {
  return state.entryListFilters[view] ?? DEFAULT_FILTER_STATE
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      theme: DEFAULT_THEME,
      designSystem: DEFAULT_DESIGN_SYSTEM,
      surfaceStyle: DEFAULT_SURFACE_STYLE,
      cornerRadius: DEFAULT_CORNER_RADIUS,
      searchOverlayOpen: false,
      commandPaletteOpen: false,
      newJournalModalOpen: false,
      templatePickerOpen: false,
      embeddingExplainerOpen: false,
      reducedMotion: false,
      disableGradientPrimary: false,
      logoFollowsCursor: false,
      uiFontScale: 1,
      mediaPageSize: 20,
      uiLanguage: 'en',
      timeFormat: '24h',
      entryListFilters: {},
      pendingRotationPhrase: null,
      pendingRotationRevealIsReset: false,
      rotationBusy: false,
      deviceRenameBusy: false,
      deviceRemovalBusy: false,
      deviceRemovalOutcome: null,
      pendingOpenPresetId: null,
      addedProviders: [],

      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

      setSidebarCollapsed: (collapsed: boolean) => set({ sidebarCollapsed: collapsed }),

      setTheme: (theme: Theme) => set({ theme: coerceTheme(theme) }),

      setDesignSystem: (designSystem: DesignSystem) => set({ designSystem }),

      setSurfaceStyle: (surfaceStyle: SurfaceStyle) => set({ surfaceStyle }),

      setCornerRadius: (cornerRadius) => set({ cornerRadius: coerceCornerRadius(cornerRadius) }),

      toggleTheme: () =>
        set((state) => ({
          theme: coerceTheme(state.theme) === 'light' ? 'dark' : 'light',
        })),

      setSearchOverlayOpen: (open: boolean) => set({ searchOverlayOpen: open }),

      setCommandPaletteOpen: (open: boolean) => set({ commandPaletteOpen: open }),

      toggleCommandPalette: () =>
        set((state) => ({ commandPaletteOpen: !state.commandPaletteOpen })),

      setNewJournalModalOpen: (open: boolean) => set({ newJournalModalOpen: open }),

      setTemplatePickerOpen: (open: boolean) => set({ templatePickerOpen: open }),

      setEmbeddingExplainerOpen: (open: boolean) => set({ embeddingExplainerOpen: open }),

      toggleSearchOverlay: () => set((state) => ({ searchOverlayOpen: !state.searchOverlayOpen })),

      setReducedMotion: (v: boolean) => set({ reducedMotion: v }),
      setDisableGradientPrimary: (v: boolean) => set({ disableGradientPrimary: v }),
      setLogoFollowsCursor: (v: boolean) => set({ logoFollowsCursor: v }),
      setUiFontScale: (uiFontScale: UiFontScale) => set({ uiFontScale }),

      setMediaPageSize: (mediaPageSize: number) => set({ mediaPageSize }),

      toggleReducedMotion: () => set((state) => ({ reducedMotion: !state.reducedMotion })),

      setUiLanguage: (uiLanguage: LanguagePreference) => set({ uiLanguage }),

      setTimeFormat: (timeFormat: TimeFormat) => set({ timeFormat }),

      setEntryListRange: (view, range) =>
        set((state) => ({
          entryListFilters: {
            ...state.entryListFilters,
            [view]: { ...(state.entryListFilters[view] ?? DEFAULT_FILTER_STATE), range },
          },
        })),

      setEntryListSort: (view, sort) =>
        set((state) => ({
          entryListFilters: {
            ...state.entryListFilters,
            [view]: { ...(state.entryListFilters[view] ?? DEFAULT_FILTER_STATE), sort },
          },
        })),

      setEntryListLockFilter: (view, lockFilter) =>
        set((state) => ({
          entryListFilters: {
            ...state.entryListFilters,
            [view]: { ...(state.entryListFilters[view] ?? DEFAULT_FILTER_STATE), lockFilter },
          },
        })),

      setEntryListJournalId: (view, journalId) =>
        set((state) => ({
          entryListFilters: {
            ...state.entryListFilters,
            [view]: { ...(state.entryListFilters[view] ?? DEFAULT_FILTER_STATE), journalId },
          },
        })),

      setPendingRotationPhrase: (phrase: string | null, isReset = false) =>
        set({
          pendingRotationPhrase: phrase,
          // A null phrase clears the reveal; force the kind back to the rotate
          // default so a stale reset flag can't mislabel the next rotate reveal.
          pendingRotationRevealIsReset: phrase === null ? false : isReset,
        }),

      setRotationBusy: (rotationBusy: boolean) => set({ rotationBusy }),

      setDeviceRenameBusy: (deviceRenameBusy: boolean) => set({ deviceRenameBusy }),

      setDeviceRemovalBusy: (deviceRemovalBusy: boolean) => set({ deviceRemovalBusy }),

      setDeviceRemovalOutcome: (deviceRemovalOutcome) => set({ deviceRemovalOutcome }),

      setPendingOpenPresetId: (presetId: string) => set({ pendingOpenPresetId: presetId }),

      clearPendingOpenPresetId: () => set({ pendingOpenPresetId: null }),

      addProvider: (presetId: string) =>
        set((state) =>
          state.addedProviders.includes(presetId)
            ? state
            : { addedProviders: [...state.addedProviders, presetId] },
        ),

      removeProvider: (presetId: string) =>
        set((state) => ({
          addedProviders: state.addedProviders.filter((id) => id !== presetId),
        })),
    }),
    {
      name: 'memlore-ui',
      partialize: (state) => ({
        sidebarCollapsed: state.sidebarCollapsed,
        theme: state.theme,
        designSystem: state.designSystem,
        surfaceStyle: state.surfaceStyle,
        cornerRadius: state.cornerRadius,
        reducedMotion: state.reducedMotion,
        disableGradientPrimary: state.disableGradientPrimary,
        logoFollowsCursor: state.logoFollowsCursor,
        uiFontScale: state.uiFontScale,
        mediaPageSize: state.mediaPageSize,
        timeFormat: state.timeFormat,
        uiLanguage: state.uiLanguage,
        addedProviders: state.addedProviders,
      }),
      // After rehydrate, coerce any unknown union-typed value (e.g.
      // legacy language or font-scale ids) to the default. Without this,
      // store state can hold a value not in the TypeScript union.
      // Settings/stats nav lives on per-tab `Tab` in tabStore — not here.
      onRehydrateStorage: () => (state) => {
        if (!state) return
        const validLanguage: LanguagePreference[] = [...SUPPORTED_LANGUAGES]
        if (!validLanguage.includes(state.uiLanguage)) {
          state.uiLanguage = DEFAULT_LANGUAGE
        }
        state.theme = coerceTheme(state.theme)
        // Leftover Lumen-as-DS blobs must be read before coerceDesignSystem
        // or the migrate signal is lost (coerce maps any unknown value,
        // 'lumen' included, to DEFAULT_DESIGN_SYSTEM).
        if ((state.designSystem as string) === 'lumen') {
          state.designSystem = 'signature'
          state.surfaceStyle = 'lumen'
        } else {
          state.surfaceStyle = coerceSurfaceStyle(state.surfaceStyle)
        }
        state.cornerRadius = coerceCornerRadius(state.cornerRadius)
        state.designSystem = coerceDesignSystem(state.designSystem)
        const validFontScale: UiFontScale[] = [1, 1.05, 1.1]
        if (!validFontScale.includes(state.uiFontScale)) {
          state.uiFontScale = 1
        }
        // `mediaPageSize` flows untrusted into the backend LIMIT. A stale or
        // corrupted persisted value (0, NaN, a future-version id) must not
        // reach the SQL — snap to the default. Keep in sync with
        // PAGE_SIZE_OPTIONS in src/components/media/galleryPageSize.ts.
        const validMediaPageSize: number[] = [12, 20, 40, 60]
        if (!validMediaPageSize.includes(state.mediaPageSize)) {
          state.mediaPageSize = 20
        }
        // A corrupted/legacy persisted blob could carry a non-array value
        // here — every reader (`addedProviders.includes(...)`, `.filter`,
        // `.map`) assumes an array, so snap back to empty rather than throw.
        if (!Array.isArray(state.addedProviders)) {
          state.addedProviders = []
        }
      },
    },
  ),
)
