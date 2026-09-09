import { describe, expect, it } from 'vitest'
import { getCommands, TOGGLE_SETTINGS, PILL_SETTINGS, SETTING_DEEPLINKS } from './registry'
import { useUiStore } from '../../stores/uiStore'
import { useSecondLockStore } from '../../stores/secondLockStore'
import { useInvisibleLockStore } from '../../stores/invisibleLockStore'
import en from '../../locales/en/palette.json'

const EXPECTED_PAGE_IDS = [
  'page.dashboard',
  'page.entries',
  'page.calendar',
  'page.tags',
  'page.onthisday',
  'page.media',
  'page.map',
  'page.stats',
  'page.chat',
  'page.settings',
  'page.about',
]

const EXPECTED_SETTINGS_CATEGORY_IDS = [
  'settings.general',
  'settings.editor',
  'settings.appearance',
  'settings.security',
  'settings.sync',
  'settings.media',
  'settings.location',
  'settings.journals',
  'settings.templates',
  'settings.reminders',
  'settings.ai',
  'settings.data',
]

const EXPECTED_SUBTAB_IDS = [
  'settings.editor_general',
  'settings.editor_layout',
  'settings.editor_font',
  'settings.appearance_theme',
  'settings.appearance_display',
  'settings.security_device_password',
  'settings.security_second_lock',
  'settings.security_recovery_devices',
  'settings.security_invisible_lock',
  'settings.sync_gdrive',
  'settings.sync_devices',
  'settings.sync_schedule',
  'settings.location_geocoding',
  'settings.location_default',
  'settings.location_saved',
  'settings.ai_models',
  'settings.ai_features',
  'settings.ai_general',
  'settings.ai_providers',
  'settings.ai_memories',
  'settings.ai_persona',
  'settings.templates_custom',
  'settings.templates_builtin',
  'settings.data_import',
  'settings.data_export',
  'settings.data_downloads',
]

const EXPECTED_ACTION_IDS = [
  'action.new_entry',
  'action.new_journal',
  'action.toggle_theme_dark',
  'action.toggle_theme_light',
  'action.toggle_sidebar',
  'action.open_search',
  'action.lock_app',
  'action.unlock_second_lock',
  'action.lock_second_lock',
  'action.unlock_invisible',
  'action.lock_invisible',
  'action.sync_now',
  'action.export_data',
  'action.import_data',
]

describe('getCommands', () => {
  it('returns a page command for every sidebar view', () => {
    const commands = getCommands()
    const ids = commands.map((c) => c.id)
    for (const expectedId of EXPECTED_PAGE_IDS) {
      expect(ids).toContain(expectedId)
    }
  })

  it('every page command has group=pages and a Lucide icon', () => {
    const commands = getCommands()
    const pageCommands = commands.filter((c) => c.group === 'pages')
    for (const cmd of pageCommands) {
      // Lucide icons are ForwardRefExoticComponent (objects), not plain functions.
      // Check that icon is defined and callable as a React component.
      expect(cmd.icon).toBeTruthy()
      expect(typeof cmd.icon).not.toBe('undefined')
    }
  })

  it('every page command has a labelKey matching its id', () => {
    const commands = getCommands()
    const pageCommands = commands.filter((c) => c.group === 'pages')
    for (const cmd of pageCommands) {
      // labelKey is the dotted path within the palette namespace (e.g. 'page.entries')
      expect(cmd.labelKey).toBe(cmd.id)
    }
  })

  it('every page command has a run function', () => {
    const commands = getCommands()
    const pageCommands = commands.filter((c) => c.group === 'pages')
    for (const cmd of pageCommands) {
      expect(typeof cmd.run).toBe('function')
    }
  })

  it('returns a settings command for every SettingsCategory', () => {
    const commands = getCommands()
    const ids = commands.map((c) => c.id)
    for (const expectedId of EXPECTED_SETTINGS_CATEGORY_IDS) {
      expect(ids).toContain(expectedId)
    }
  })

  it('returns sub-tab commands for categories with internal tabs', () => {
    const commands = getCommands()
    const ids = commands.map((c) => c.id)
    // Spot-check a known sub-tab id
    expect(ids).toContain('settings.editor')
    expect(ids).toContain('settings.security_second_lock')
    expect(ids).toContain('settings.data_downloads')
    // Verify total sub-tab count
    const subtabCommands = commands.filter((c) => EXPECTED_SUBTAB_IDS.includes(c.id))
    expect(subtabCommands).toHaveLength(26)
  })

  it('every settings command has group=settings', () => {
    const commands = getCommands()
    const settingsCommands = commands.filter(
      (c) => EXPECTED_SETTINGS_CATEGORY_IDS.includes(c.id) || EXPECTED_SUBTAB_IDS.includes(c.id),
    )
    for (const cmd of settingsCommands) {
      expect(cmd.group).toBe('settings')
    }
  })

  it('includes all expected action commands', () => {
    const commands = getCommands()
    const ids = commands.map((c) => c.id)
    for (const expectedId of EXPECTED_ACTION_IDS) {
      expect(ids).toContain(expectedId)
    }
  })

  it('theme toggle commands are available under Signature except the current theme', () => {
    const commands = getCommands()
    const darkCmd = commands.find((c) => c.id === 'action.toggle_theme_dark')
    const lightCmd = commands.find((c) => c.id === 'action.toggle_theme_light')

    useUiStore.setState({ designSystem: 'signature' })
    for (const theme of ['dark', 'light'] as const) {
      useUiStore.setState({ theme })
      expect(darkCmd?.available?.()).toBe(theme !== 'dark')
      expect(lightCmd?.available?.()).toBe(theme !== 'light')
    }
  })

  it('theme toggle commands are available under Clean except the current theme', () => {
    const commands = getCommands()
    const darkCmd = commands.find((c) => c.id === 'action.toggle_theme_dark')
    const lightCmd = commands.find((c) => c.id === 'action.toggle_theme_light')

    useUiStore.setState({ designSystem: 'clean' })
    for (const theme of ['dark', 'light'] as const) {
      useUiStore.setState({ theme })
      expect(darkCmd?.available?.()).toBe(theme !== 'dark')
      expect(lightCmd?.available?.()).toBe(theme !== 'light')
    }
  })

  it('second-lock commands gate by session state', () => {
    const commands = getCommands()
    const unlockCmd = commands.find((c) => c.id === 'action.unlock_second_lock')
    const lockCmd = commands.find((c) => c.id === 'action.lock_second_lock')

    useSecondLockStore.setState({ isEnabled: false, isSessionUnlocked: false })
    expect(unlockCmd?.available?.()).toBe(false)
    expect(lockCmd?.available?.()).toBe(false)

    useSecondLockStore.setState({ isEnabled: true, isSessionUnlocked: false })
    expect(unlockCmd?.available?.()).toBe(true)
    expect(lockCmd?.available?.()).toBe(false)

    useSecondLockStore.setState({ isEnabled: true, isSessionUnlocked: true })
    expect(unlockCmd?.available?.()).toBe(false)
    expect(lockCmd?.available?.()).toBe(true)

    lockCmd?.run()
    expect(useSecondLockStore.getState().isSessionUnlocked).toBe(false)
  })

  it('invisible-lock commands expose unlock and gate lock by session state', () => {
    const commands = getCommands()
    const unlockCmd = commands.find((c) => c.id === 'action.unlock_invisible')
    const lockCmd = commands.find((c) => c.id === 'action.lock_invisible')

    useInvisibleLockStore.setState({ activeVaultId: null })
    expect(unlockCmd?.available?.()).toBeUndefined()
    expect(lockCmd?.available?.()).toBe(false)

    useInvisibleLockStore.setState({ activeVaultId: 'vault-a' })
    expect(lockCmd?.available?.()).toBe(true)

    lockCmd?.run()
    expect(useInvisibleLockStore.getState().activeVaultId).toBeNull()
  })
})

// ── Settings-value toggle commands ──────────────────────────────────────

describe('toggle settings commands', () => {
  it('includes dashboard_insights next to theme_insights', () => {
    const ids = TOGGLE_SETTINGS.map((t) => t.id)
    expect(ids).toContain('dashboard_insights')
    expect(ids.indexOf('dashboard_insights')).toBe(ids.indexOf('theme_insights') + 1)
  })

  it.each(TOGGLE_SETTINGS.map((t) => [t.id]))(
    'toggle "%s" yields exactly one enable and one disable command',
    (id) => {
      const commands = getCommands()
      const enable = commands.filter((c) => c.id === `settings_value.${id}.enable`)
      const disable = commands.filter((c) => c.id === `settings_value.${id}.disable`)
      expect(enable).toHaveLength(1)
      expect(disable).toHaveLength(1)
      expect(enable[0].group).toBe('settings_values')
      expect(disable[0].group).toBe('settings_values')
    },
  )

  it('settings_values group is present in commands', () => {
    const commands = getCommands()
    expect(commands.some((c) => c.group === 'settings_values')).toBe(true)
  })
})

// ── Settings-value pill commands ────────────────────────────────────────

describe('pill settings commands', () => {
  it.each(PILL_SETTINGS.map((p) => [p.id, p.options.length]))(
    'pill "%s" yields %d commands',
    (id, count) => {
      const commands = getCommands()
      const pillCmds = commands.filter(
        (c) => c.group === 'settings_values' && c.id.startsWith(`settings_value.${id}.`),
      )
      expect(pillCmds).toHaveLength(count)
    },
  )
})

// ── Deep-link commands ──────────────────────────────────────────────────

describe('deep-link commands', () => {
  it.each(SETTING_DEEPLINKS.map((dl) => [dl.id]))('deep-link "%s" is in getCommands()', (id) => {
    const commands = getCommands()
    expect(commands.some((c) => c.id === id)).toBe(true)
  })
})

// ── Cross-cutting assertions ────────────────────────────────────────────

describe('command id uniqueness', () => {
  it('all command ids are unique', () => {
    const commands = getCommands()
    const ids = commands.map((c) => c.id)
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
    expect(dupes).toEqual([])
  })
})

describe('i18n key coverage', () => {
  /** Resolve a dot-path key against a nested object. */
  function resolve(obj: Record<string, unknown>, path: string): unknown {
    let cur: unknown = obj
    for (const segment of path.split('.')) {
      if (typeof cur !== 'object' || cur === null) return undefined
      cur = (cur as Record<string, unknown>)[segment]
    }
    return cur
  }

  it('every generated labelKey exists in en/palette.json', () => {
    const commands = getCommands()
    const missing: string[] = []
    for (const cmd of commands) {
      if (cmd.labelKey.startsWith('@@')) continue // dynamic labels
      if (resolve(en, cmd.labelKey) === undefined) {
        missing.push(cmd.labelKey)
      }
    }
    expect(missing).toEqual([])
  })
})

// ── Gating behaviour ────────────────────────────────────────────────────

describe('toggle gating', () => {
  it('appearance reduced_motion: exactly one of enable/disable is available', () => {
    const commands = getCommands()
    const enableRM = commands.find((c) => c.id === 'settings_value.reduced_motion.enable')!
    const disableRM = commands.find((c) => c.id === 'settings_value.reduced_motion.disable')!

    useUiStore.setState({ reducedMotion: true })
    expect(enableRM.available?.()).toBe(false)
    expect(disableRM.available?.()).toBe(true)

    useUiStore.setState({ reducedMotion: false })
    expect(enableRM.available?.()).toBe(true)
    expect(disableRM.available?.()).toBe(false)
  })

  it('does not expose a background_effect toggle', () => {
    const commands = getCommands()
    expect(commands.some((c) => c.id.startsWith('settings_value.background_effect.'))).toBe(false)
    expect(TOGGLE_SETTINGS.some((t) => t.id === 'background_effect')).toBe(false)
  })

  it('gradient_primary is unavailable under Clean and available under Signature and Clay', () => {
    const commands = getCommands()
    const enableGrad = commands.find((c) => c.id === 'settings_value.gradient_primary.enable')!
    const disableGrad = commands.find((c) => c.id === 'settings_value.gradient_primary.disable')!

    useUiStore.setState({ designSystem: 'clean', disableGradientPrimary: false })
    expect(enableGrad.available?.()).toBe(false)
    expect(disableGrad.available?.()).toBe(false)

    useUiStore.setState({ designSystem: 'signature', disableGradientPrimary: false })
    expect(enableGrad.available?.()).toBe(false)
    expect(disableGrad.available?.()).toBe(true)

    useUiStore.setState({ designSystem: 'clay', disableGradientPrimary: true })
    expect(enableGrad.available?.()).toBe(true)
    expect(disableGrad.available?.()).toBe(false)
  })

  it('second_lock_show_existence: available only when second lock enabled', () => {
    const commands = getCommands()
    const enableCmd = commands.find(
      (c) => c.id === 'settings_value.second_lock_show_existence.enable',
    )!
    const disableCmd = commands.find(
      (c) => c.id === 'settings_value.second_lock_show_existence.disable',
    )!

    useSecondLockStore.setState({ isEnabled: false, showExistence: false })
    expect(enableCmd.available?.()).toBe(false)
    expect(disableCmd.available?.()).toBe(false)

    useSecondLockStore.setState({ isEnabled: true, showExistence: false })
    expect(enableCmd.available?.()).toBe(true)
    expect(disableCmd.available?.()).toBe(false)

    useSecondLockStore.setState({ isEnabled: true, showExistence: true })
    expect(enableCmd.available?.()).toBe(false)
    expect(disableCmd.available?.()).toBe(true)
  })
})

describe('pill gating', () => {
  it('design_system: current value is hidden', () => {
    const commands = getCommands()
    const sigCmd = commands.find((c) => c.id === 'settings_value.design_system.signature')!
    const cleanCmd = commands.find((c) => c.id === 'settings_value.design_system.clean')!

    useUiStore.setState({ designSystem: 'signature' })
    expect(sigCmd.available?.()).toBe(false)
    expect(cleanCmd.available?.()).toBe(true)

    useUiStore.setState({ designSystem: 'clean' })
    expect(sigCmd.available?.()).toBe(true)
    expect(cleanCmd.available?.()).toBe(false)
  })

  it('time_format: current value is hidden', () => {
    const commands = getCommands()
    const h24 = commands.find((c) => c.id === 'settings_value.time_format.24h')!
    const h12 = commands.find((c) => c.id === 'settings_value.time_format.12h')!

    useUiStore.setState({ timeFormat: '24h' })
    expect(h24.available?.()).toBe(false)
    expect(h12.available?.()).toBe(true)

    useUiStore.setState({ timeFormat: '12h' })
    expect(h24.available?.()).toBe(true)
    expect(h12.available?.()).toBe(false)
  })

  it('surface_style: available only when signature', () => {
    const commands = getCommands()
    const deepCmd = commands.find((c) => c.id === 'settings_value.surface_style.deep')
    const softCmd = commands.find((c) => c.id === 'settings_value.surface_style.soft')
    const lumenCmd = commands.find((c) => c.id === 'settings_value.surface_style.lumen')
    expect(deepCmd).toBeDefined()
    expect(softCmd).toBeDefined()
    expect(lumenCmd).toBeDefined()
    expect(commands.some((c) => c.id === 'settings_value.design_system.lumen')).toBe(false)

    useUiStore.setState({ designSystem: 'clean' })
    expect(deepCmd?.available?.()).toBe(false)
    expect(softCmd?.available?.()).toBe(false)
    expect(lumenCmd?.available?.()).toBe(false)

    useUiStore.setState({ designSystem: 'signature' })
    // At least one non-current value should be available
    const deepAvail = deepCmd?.available?.()
    const softAvail = softCmd?.available?.()
    const lumenAvail = lumenCmd?.available?.()
    expect(deepAvail || softAvail || lumenAvail).toBe(true)
  })
})
