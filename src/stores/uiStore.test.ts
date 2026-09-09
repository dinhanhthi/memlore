import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  DEFAULT_CORNER_RADIUS,
  DEFAULT_DESIGN_SYSTEM,
  DEFAULT_SURFACE_STYLE,
} from '../lib/designSystem'
import {
  coerceDataTab,
  coerceTheme,
  DEFAULT_THEME,
  getEntryListFilter,
  useUiStore,
  validDataTabs,
} from './uiStore'

// matchMedia is not available in jsdom — provide a default stub that reports
// OS preference as 'light' (matches: false for the dark query).
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

// Reset store state before each test. Clear localStorage so Zustand persist
// can't bleed values from a prior test into the next one.
beforeEach(() => {
  globalThis.localStorage.clear()
  useUiStore.setState({
    sidebarCollapsed: false,
    theme: DEFAULT_THEME,
    designSystem: DEFAULT_DESIGN_SYSTEM,
    surfaceStyle: DEFAULT_SURFACE_STYLE,
    cornerRadius: DEFAULT_CORNER_RADIUS,
    searchOverlayOpen: false,
    reducedMotion: false,
    uiLanguage: 'en',
    timeFormat: '24h',
    rotationBusy: false,
    deviceRenameBusy: false,
    deviceRemovalBusy: false,
    deviceRemovalOutcome: null,
    entryListFilters: {},
    pendingOpenPresetId: null,
    addedProviders: [],
  })
})

describe('uiStore', () => {
  describe('initial state', () => {
    it('has sidebar expanded by default', () => {
      expect(useUiStore.getState().sidebarCollapsed).toBe(false)
    })

    it('has dark theme by default', () => {
      expect(DEFAULT_THEME).toBe('dark')
      expect(useUiStore.getState().theme).toBe('dark')
    })
  })

  describe('coerceTheme', () => {
    it('keeps light and dark', () => {
      expect(coerceTheme('light')).toBe('light')
      expect(coerceTheme('dark')).toBe('dark')
    })

    it('maps system and unknown values to dark', () => {
      expect(coerceTheme('system')).toBe('dark')
      expect(coerceTheme('auto')).toBe('dark')
      expect(coerceTheme(undefined)).toBe('dark')
    })
  })

  describe('toggleSidebar', () => {
    it('collapses an expanded sidebar', () => {
      useUiStore.getState().toggleSidebar()
      expect(useUiStore.getState().sidebarCollapsed).toBe(true)
    })

    it('expands a collapsed sidebar', () => {
      useUiStore.setState({ sidebarCollapsed: true })
      useUiStore.getState().toggleSidebar()
      expect(useUiStore.getState().sidebarCollapsed).toBe(false)
    })

    it('toggles multiple times correctly', () => {
      const { toggleSidebar } = useUiStore.getState()
      toggleSidebar()
      toggleSidebar()
      toggleSidebar()
      expect(useUiStore.getState().sidebarCollapsed).toBe(true)
    })
  })

  describe('setSidebarCollapsed', () => {
    it('sets sidebar to collapsed', () => {
      useUiStore.getState().setSidebarCollapsed(true)
      expect(useUiStore.getState().sidebarCollapsed).toBe(true)
    })

    it('sets sidebar to expanded', () => {
      useUiStore.setState({ sidebarCollapsed: true })
      useUiStore.getState().setSidebarCollapsed(false)
      expect(useUiStore.getState().sidebarCollapsed).toBe(false)
    })
  })

  describe('setTheme', () => {
    it('sets theme to dark', () => {
      useUiStore.getState().setTheme('dark')
      expect(useUiStore.getState().theme).toBe('dark')
    })

    it('sets theme to light', () => {
      useUiStore.setState({ theme: 'dark' })
      useUiStore.getState().setTheme('light')
      expect(useUiStore.getState().theme).toBe('light')
    })
  })

  describe('toggleTheme — basic light↔dark cycle', () => {
    it('moves off light on first toggle (advances cycle)', () => {
      useUiStore.setState({ theme: 'light' })
      useUiStore.getState().toggleTheme()
      expect(useUiStore.getState().theme).toBe('dark')
    })

    it('moves off dark on first toggle (advances cycle)', () => {
      useUiStore.setState({ theme: 'dark' })
      useUiStore.getState().toggleTheme()
      expect(useUiStore.getState().theme).toBe('light')
    })
  })

  describe('commandPaletteOpen', () => {
    it('toggleCommandPalette flips commandPaletteOpen', () => {
      useUiStore.setState({ commandPaletteOpen: false })
      useUiStore.getState().toggleCommandPalette()
      expect(useUiStore.getState().commandPaletteOpen).toBe(true)
      useUiStore.getState().toggleCommandPalette()
      expect(useUiStore.getState().commandPaletteOpen).toBe(false)
    })
  })

  describe('searchOverlayOpen', () => {
    it('is closed by default', () => {
      expect(useUiStore.getState().searchOverlayOpen).toBe(false)
    })

    it('opens and closes via setSearchOverlayOpen', () => {
      useUiStore.getState().setSearchOverlayOpen(true)
      expect(useUiStore.getState().searchOverlayOpen).toBe(true)
      useUiStore.getState().setSearchOverlayOpen(false)
      expect(useUiStore.getState().searchOverlayOpen).toBe(false)
    })

    it('toggles with toggleSearchOverlay', () => {
      useUiStore.getState().toggleSearchOverlay()
      expect(useUiStore.getState().searchOverlayOpen).toBe(true)
      useUiStore.getState().toggleSearchOverlay()
      expect(useUiStore.getState().searchOverlayOpen).toBe(false)
    })
  })

  describe('persistence', () => {
    // Lock the partialized subset down: searchOverlayOpen must NOT be persisted
    // (overlay would reopen every launch). reducedMotion MUST be persisted so
    // the user's explicit preference survives restarts.
    // Settings/stats nav lives on per-tab Tab in tabStore — not in memlore-ui.
    it('persists sidebarCollapsed, theme, reducedMotion, uiLanguage, and timeFormat (not searchOverlayOpen or settings nav)', () => {
      useUiStore.setState({
        sidebarCollapsed: true,
        theme: 'dark',
        searchOverlayOpen: true,
        reducedMotion: true,
        timeFormat: '12h',
      })
      const persisted = JSON.parse(globalThis.localStorage.getItem('memlore-ui') ?? '{}') as {
        state?: Record<string, unknown>
      }
      expect(persisted.state).toEqual({
        sidebarCollapsed: true,
        theme: 'dark',
        designSystem: DEFAULT_DESIGN_SYSTEM,
        surfaceStyle: 'deep',
        cornerRadius: 'low',
        reducedMotion: true,
        disableGradientPrimary: false,
        logoFollowsCursor: false,
        uiFontScale: 1,
        mediaPageSize: 20,
        uiLanguage: 'en',
        timeFormat: '12h',
        addedProviders: [],
      })
      // Orphaned settings-nav keys from older releases must not reappear.
      expect(persisted.state).not.toHaveProperty('settingsCategory')
      expect(persisted.state).not.toHaveProperty('statsTab')
      expect(persisted.state).not.toHaveProperty('securityTab')
    })

    it('coerceDataTab keeps demo only in DEV builds', () => {
      expect(validDataTabs(true)).toEqual(['import', 'export', 'downloads', 'demo'])
      expect(validDataTabs(false)).toEqual(['import', 'export', 'downloads'])
      expect(coerceDataTab('demo', true)).toBe('demo')
      expect(coerceDataTab('demo', false)).toBe('import')
      expect(coerceDataTab('export', false)).toBe('export')
      expect(coerceDataTab('downloads', true)).toBe('downloads')
      expect(coerceDataTab('downloads', false)).toBe('downloads')
      expect(coerceDataTab('qux', true)).toBe('import')
    })

    it('rehydrate snaps an out-of-catalog mediaPageSize back to the default', async () => {
      // `mediaPageSize` flows untrusted into the backend LIMIT. A stale or
      // corrupted persisted value (0, NaN, a removed option) must not reach
      // the SQL — the merge step snaps anything outside 12/20/40/60 to 20.
      globalThis.localStorage.setItem(
        'memlore-ui',
        JSON.stringify({
          state: { mediaPageSize: 999 },
          version: 0,
        }),
      )

      await useUiStore.persist.rehydrate()
      expect(useUiStore.getState().mediaPageSize).toBe(20)

      globalThis.localStorage.setItem(
        'memlore-ui',
        JSON.stringify({
          state: { mediaPageSize: 40 },
          version: 0,
        }),
      )

      await useUiStore.persist.rehydrate()
      expect(useUiStore.getState().mediaPageSize).toBe(40)
    })
  })

  describe('uiFontScale', () => {
    it('defaults to 1', () => {
      expect(useUiStore.getState().uiFontScale).toBe(1)
    })

    it('setUiFontScale updates the store', () => {
      useUiStore.getState().setUiFontScale(1.1)
      expect(useUiStore.getState().uiFontScale).toBe(1.1)
    })

    it('persists uiFontScale to localStorage', () => {
      useUiStore.getState().setUiFontScale(1.1)
      const persisted = JSON.parse(globalThis.localStorage.getItem('memlore-ui') ?? '{}') as {
        state?: Record<string, unknown>
      }
      expect(persisted.state?.uiFontScale).toBe(1.1)
    })

    it('rehydrate coerces an unknown uiFontScale back to 1', async () => {
      globalThis.localStorage.setItem(
        'memlore-ui',
        JSON.stringify({
          state: { uiFontScale: 2.5 }, // unknown / legacy value
          version: 0,
        }),
      )

      await useUiStore.persist.rehydrate()

      expect(useUiStore.getState().uiFontScale).toBe(1)
    })
  })

  describe('designSystem', () => {
    it('defaults to clay', () => {
      expect(DEFAULT_DESIGN_SYSTEM).toBe('clay')
      expect(useUiStore.getState().designSystem).toBe('clay')
    })

    it("setDesignSystem('clean') updates state", () => {
      useUiStore.getState().setDesignSystem('clean')
      expect(useUiStore.getState().designSystem).toBe('clean')
    })

    it('appears in the persisted partialize output', () => {
      useUiStore.getState().setDesignSystem('clean')
      const persisted = JSON.parse(globalThis.localStorage.getItem('memlore-ui') ?? '{}') as {
        state?: Record<string, unknown>
      }
      expect(persisted.state?.designSystem).toBe('clean')
    })

    it("rehydrate coerces an unknown designSystem ('shadcn-v2') back to the default", async () => {
      globalThis.localStorage.setItem(
        'memlore-ui',
        JSON.stringify({
          state: { designSystem: 'shadcn-v2' },
          version: 0,
        }),
      )

      await useUiStore.persist.rehydrate()

      expect(useUiStore.getState().designSystem).toBe(DEFAULT_DESIGN_SYSTEM)
    })

    it("rehydrate maps leftover designSystem 'lumen' to signature + surfaceStyle lumen", async () => {
      globalThis.localStorage.setItem(
        'memlore-ui',
        JSON.stringify({
          state: { designSystem: 'lumen' },
          version: 0,
        }),
      )

      await useUiStore.persist.rehydrate()

      expect(useUiStore.getState().designSystem).toBe('signature')
      expect(useUiStore.getState().surfaceStyle).toBe('lumen')

      // onRehydrateStorage mutates in place; persist writes on the next set().
      useUiStore.setState({})
      const persisted = JSON.parse(globalThis.localStorage.getItem('memlore-ui') ?? '{}') as {
        state?: Record<string, unknown>
      }
      expect(persisted.state?.designSystem).toBe('signature')
      expect(persisted.state?.surfaceStyle).toBe('lumen')
    })
  })

  describe('surfaceStyle', () => {
    it("defaults to 'deep'", () => {
      expect(useUiStore.getState().surfaceStyle).toBe('deep')
    })

    it("setSurfaceStyle('lumen') updates state and appears in partialize", () => {
      useUiStore.getState().setSurfaceStyle('lumen')
      expect(useUiStore.getState().surfaceStyle).toBe('lumen')
      const persisted = JSON.parse(globalThis.localStorage.getItem('memlore-ui') ?? '{}') as {
        state?: Record<string, unknown>
      }
      expect(persisted.state?.surfaceStyle).toBe('lumen')
    })

    it("rehydrate coerces a missing surfaceStyle back to 'deep'", async () => {
      globalThis.localStorage.setItem(
        'memlore-ui',
        JSON.stringify({
          state: { designSystem: 'signature' },
          version: 0,
        }),
      )

      await useUiStore.persist.rehydrate()

      expect(useUiStore.getState().surfaceStyle).toBe('deep')
    })
  })

  describe('cornerRadius', () => {
    it("defaults to 'low'", () => {
      expect(useUiStore.getState().cornerRadius).toBe('low')
    })

    it("rehydrate coerces a garbage value ('HIGH') to 'low'", async () => {
      globalThis.localStorage.setItem(
        'memlore-ui',
        JSON.stringify({
          state: { cornerRadius: 'HIGH' },
          version: 0,
        }),
      )

      await useUiStore.persist.rehydrate()

      expect(useUiStore.getState().cornerRadius).toBe('low')
    })

    it("rehydrate keeps a valid stored 'high'", async () => {
      globalThis.localStorage.setItem(
        'memlore-ui',
        JSON.stringify({
          state: { cornerRadius: 'high' },
          version: 0,
        }),
      )

      await useUiStore.persist.rehydrate()

      expect(useUiStore.getState().cornerRadius).toBe('high')
    })
  })

  describe('rotationBusy', () => {
    it('is false by default', () => {
      expect(useUiStore.getState().rotationBusy).toBe(false)
    })

    it('setRotationBusy(true) locks rotation-class actions', () => {
      useUiStore.getState().setRotationBusy(true)
      expect(useUiStore.getState().rotationBusy).toBe(true)
    })

    it('setRotationBusy(false) releases the lock', () => {
      useUiStore.setState({ rotationBusy: true })
      useUiStore.getState().setRotationBusy(false)
      expect(useUiStore.getState().rotationBusy).toBe(false)
    })

    it('is NOT persisted to localStorage (transient — a stuck-true value would deadlock the UI)', () => {
      useUiStore.getState().setRotationBusy(true)
      const persisted = JSON.parse(globalThis.localStorage.getItem('memlore-ui') ?? '{}') as {
        state?: Record<string, unknown>
      }
      expect(persisted.state).not.toHaveProperty('rotationBusy')
    })
  })

  describe('deviceRemovalOutcome', () => {
    it('defaults to null', () => {
      expect(useUiStore.getState().deviceRemovalOutcome).toBeNull()
    })

    it("setDeviceRemovalOutcome('ok') records a success", () => {
      useUiStore.getState().setDeviceRemovalOutcome('ok')
      expect(useUiStore.getState().deviceRemovalOutcome).toBe('ok')
    })

    it("setDeviceRemovalOutcome('error') records a failure", () => {
      useUiStore.getState().setDeviceRemovalOutcome('error')
      expect(useUiStore.getState().deviceRemovalOutcome).toBe('error')
    })

    it('setDeviceRemovalOutcome(null) dismisses the notice', () => {
      useUiStore.setState({ deviceRemovalOutcome: 'error' })
      useUiStore.getState().setDeviceRemovalOutcome(null)
      expect(useUiStore.getState().deviceRemovalOutcome).toBeNull()
    })

    it('is NOT persisted to localStorage (transient — a leftover outcome would reappear after restart)', () => {
      useUiStore.getState().setDeviceRemovalOutcome('error')
      const persisted = JSON.parse(globalThis.localStorage.getItem('memlore-ui') ?? '{}') as {
        state?: Record<string, unknown>
      }
      expect(persisted.state).not.toHaveProperty('deviceRemovalOutcome')
    })
  })

  describe('deviceRenameBusy', () => {
    it('is false by default', () => {
      expect(useUiStore.getState().deviceRenameBusy).toBe(false)
    })

    it('setDeviceRenameBusy(true) locks rename-class UI', () => {
      useUiStore.getState().setDeviceRenameBusy(true)
      expect(useUiStore.getState().deviceRenameBusy).toBe(true)
    })

    it('setDeviceRenameBusy(false) releases the lock', () => {
      useUiStore.setState({ deviceRenameBusy: true })
      useUiStore.getState().setDeviceRenameBusy(false)
      expect(useUiStore.getState().deviceRenameBusy).toBe(false)
    })

    it('is NOT persisted to localStorage (transient — a stuck-true value would deadlock the UI)', () => {
      useUiStore.getState().setDeviceRenameBusy(true)
      const persisted = JSON.parse(globalThis.localStorage.getItem('memlore-ui') ?? '{}') as {
        state?: Record<string, unknown>
      }
      expect(persisted.state).not.toHaveProperty('deviceRenameBusy')
    })
  })

  describe('reducedMotion', () => {
    it('is false by default', () => {
      expect(useUiStore.getState().reducedMotion).toBe(false)
    })

    it('setReducedMotion(true) enables reduced motion', () => {
      useUiStore.getState().setReducedMotion(true)
      expect(useUiStore.getState().reducedMotion).toBe(true)
    })

    it('setReducedMotion(false) disables reduced motion', () => {
      useUiStore.setState({ reducedMotion: true })
      useUiStore.getState().setReducedMotion(false)
      expect(useUiStore.getState().reducedMotion).toBe(false)
    })

    it('toggleReducedMotion flips from false to true', () => {
      useUiStore.getState().toggleReducedMotion()
      expect(useUiStore.getState().reducedMotion).toBe(true)
    })

    it('toggleReducedMotion flips from true to false', () => {
      useUiStore.setState({ reducedMotion: true })
      useUiStore.getState().toggleReducedMotion()
      expect(useUiStore.getState().reducedMotion).toBe(false)
    })
  })

  describe('theme rehydrate', () => {
    it('coerces a persisted system theme to dark', async () => {
      globalThis.localStorage.setItem(
        'memlore-ui',
        JSON.stringify({
          state: { theme: 'system' },
          version: 0,
        }),
      )

      await useUiStore.persist.rehydrate()

      expect(useUiStore.getState().theme).toBe('dark')
    })
  })

  describe('uiLanguage', () => {
    it("defaults to 'en'", () => {
      expect(useUiStore.getState().uiLanguage).toBe('en')
    })

    it("setUiLanguage accepts 'en'", () => {
      useUiStore.setState({ uiLanguage: 'vi' })
      useUiStore.getState().setUiLanguage('en')
      expect(useUiStore.getState().uiLanguage).toBe('en')
    })

    it("setUiLanguage accepts 'vi'", () => {
      useUiStore.getState().setUiLanguage('vi')
      expect(useUiStore.getState().uiLanguage).toBe('vi')
    })

    it('IS persisted to localStorage (localStorage is the source of truth, per-device)', () => {
      useUiStore.setState({ uiLanguage: 'vi' })
      const persisted = JSON.parse(globalThis.localStorage.getItem('memlore-ui') ?? '{}') as {
        state?: Record<string, unknown>
      }
      expect(persisted.state?.uiLanguage).toBe('vi')
    })

    it('rehydrate coerces an unsupported stored uiLanguage to DEFAULT_LANGUAGE', async () => {
      globalThis.localStorage.setItem(
        'memlore-ui',
        JSON.stringify({
          state: { uiLanguage: 'fr' }, // unsupported
          version: 0,
        }),
      )

      await useUiStore.persist.rehydrate()

      expect(useUiStore.getState().uiLanguage).toBe('en')
    })

    it('rehydrate falls back to DEFAULT_LANGUAGE when uiLanguage is absent from an old persisted blob', async () => {
      globalThis.localStorage.setItem(
        'memlore-ui',
        JSON.stringify({
          state: { sidebarCollapsed: true }, // no uiLanguage key at all
          version: 0,
        }),
      )

      await expect(useUiStore.persist.rehydrate()).resolves.not.toThrow()

      expect(useUiStore.getState().uiLanguage).toBe('en')
    })
  })

  describe('toggleTheme cycle', () => {
    it('cycles light → dark', () => {
      useUiStore.setState({ theme: 'light' })
      useUiStore.getState().toggleTheme()
      expect(useUiStore.getState().theme).toBe('dark')
    })

    it('cycles dark → light', () => {
      useUiStore.setState({ theme: 'dark' })
      useUiStore.getState().toggleTheme()
      expect(useUiStore.getState().theme).toBe('light')
    })

    it('full cycle returns to light after 2 toggles', () => {
      useUiStore.setState({ theme: 'light' })
      useUiStore.getState().toggleTheme()
      useUiStore.getState().toggleTheme()
      expect(useUiStore.getState().theme).toBe('light')
    })

    it('treats a leftover system value as dark and toggles to light', () => {
      useUiStore.setState({ theme: 'system' as unknown as 'light' })
      useUiStore.getState().toggleTheme()
      expect(useUiStore.getState().theme).toBe('light')
    })
  })

  describe('pendingOpenPresetId', () => {
    it('defaults to null', () => {
      expect(useUiStore.getState().pendingOpenPresetId).toBeNull()
    })

    it('setPendingOpenPresetId sets the requested preset id', () => {
      useUiStore.getState().setPendingOpenPresetId('openai')
      expect(useUiStore.getState().pendingOpenPresetId).toBe('openai')
    })

    it('clearPendingOpenPresetId resets it back to null', () => {
      useUiStore.getState().setPendingOpenPresetId('openai')
      useUiStore.getState().clearPendingOpenPresetId()
      expect(useUiStore.getState().pendingOpenPresetId).toBeNull()
    })

    it('supports the full set → consume → clear lifecycle', () => {
      // Simulates a feature tab requesting the Providers tab open a specific
      // preset's accordion, then the Providers tab consuming and clearing it.
      useUiStore.getState().setPendingOpenPresetId('anthropic')
      const requested = useUiStore.getState().pendingOpenPresetId
      expect(requested).toBe('anthropic')

      // Consumer would add `requested` to its own open-ids set here, then
      // immediately clear the pending request.
      useUiStore.getState().clearPendingOpenPresetId()
      expect(useUiStore.getState().pendingOpenPresetId).toBeNull()
    })

    it('is NOT persisted to localStorage (a stuck value would force-open an accordion on every future visit)', () => {
      useUiStore.getState().setPendingOpenPresetId('openai')
      const persisted = JSON.parse(globalThis.localStorage.getItem('memlore-ui') ?? '{}') as {
        state?: Record<string, unknown>
      }
      expect(persisted.state).not.toHaveProperty('pendingOpenPresetId')
    })
  })

  describe('addedProviders', () => {
    it('defaults to an empty array', () => {
      expect(useUiStore.getState().addedProviders).toEqual([])
    })

    it('addProvider appends a preset id', () => {
      useUiStore.getState().addProvider('openai')
      expect(useUiStore.getState().addedProviders).toEqual(['openai'])
    })

    it('addProvider dedupes — adding the same id twice keeps one entry', () => {
      useUiStore.getState().addProvider('openai')
      useUiStore.getState().addProvider('openai')
      expect(useUiStore.getState().addedProviders).toEqual(['openai'])
    })

    it('addProvider appends multiple distinct ids in call order', () => {
      useUiStore.getState().addProvider('openai')
      useUiStore.getState().addProvider('claude-cli')
      expect(useUiStore.getState().addedProviders).toEqual(['openai', 'claude-cli'])
    })

    it('removeProvider removes a single id, leaving the rest untouched', () => {
      useUiStore.getState().addProvider('openai')
      useUiStore.getState().addProvider('claude-cli')
      useUiStore.getState().removeProvider('openai')
      expect(useUiStore.getState().addedProviders).toEqual(['claude-cli'])
    })

    it('removeProvider on an id that is not present is a no-op', () => {
      useUiStore.getState().addProvider('openai')
      useUiStore.getState().removeProvider('anthropic')
      expect(useUiStore.getState().addedProviders).toEqual(['openai'])
    })

    it('is persisted to localStorage (per-device "which providers do I care about" list)', () => {
      useUiStore.getState().addProvider('openai')
      useUiStore.getState().addProvider('ollama')
      const persisted = JSON.parse(globalThis.localStorage.getItem('memlore-ui') ?? '{}') as {
        state?: Record<string, unknown>
      }
      expect(persisted.state?.addedProviders).toEqual(['openai', 'ollama'])
    })

    it('rehydrate coerces a non-array persisted value back to an empty array', async () => {
      globalThis.localStorage.setItem(
        'memlore-ui',
        JSON.stringify({
          state: { addedProviders: 'openai' }, // corrupted / legacy shape
          version: 0,
        }),
      )

      await useUiStore.persist.rehydrate()

      expect(useUiStore.getState().addedProviders).toEqual([])
    })

    it('rehydrate keeps a valid persisted array', async () => {
      globalThis.localStorage.setItem(
        'memlore-ui',
        JSON.stringify({
          state: { addedProviders: ['openai', 'ollama'] },
          version: 0,
        }),
      )

      await useUiStore.persist.rehydrate()

      expect(useUiStore.getState().addedProviders).toEqual(['openai', 'ollama'])
    })
  })

  // Journal filter is scoped per-view (like range/sort/lockFilter) so picking a
  // journal on one page never leaks into another — the reported bug.
  describe('entryListFilters — per-view journal scope', () => {
    it('defaults journalId to null for an unset view', () => {
      expect(getEntryListFilter(useUiStore.getState(), 'all').journalId).toBeNull()
    })

    it('setEntryListJournalId isolates the journal filter to its own view', () => {
      useUiStore.getState().setEntryListJournalId('all', 'journal-1')

      expect(getEntryListFilter(useUiStore.getState(), 'all').journalId).toBe('journal-1')
      // Other views must stay unaffected — this is the cross-page isolation.
      expect(getEntryListFilter(useUiStore.getState(), 'tags').journalId).toBeNull()
      expect(getEntryListFilter(useUiStore.getState(), 'onthisday').journalId).toBeNull()

      useUiStore.getState().setEntryListJournalId('tags', 'journal-2')

      expect(getEntryListFilter(useUiStore.getState(), 'all').journalId).toBe('journal-1')
      expect(getEntryListFilter(useUiStore.getState(), 'tags').journalId).toBe('journal-2')
    })

    it('preserves range/sort/lockFilter when the journal filter changes', () => {
      useUiStore.getState().setEntryListSort('all', 'oldest')
      useUiStore.getState().setEntryListJournalId('all', 'journal-1')

      const filter = getEntryListFilter(useUiStore.getState(), 'all')
      expect(filter.sort).toBe('oldest')
      expect(filter.journalId).toBe('journal-1')
    })
  })
})
