import { describe, expect, it } from 'vitest'
import type { SettingsCategory } from '../stores/uiStore'
import { capabilities, type Capabilities } from './platform'
import { isSettingsCategoryAvailable } from './settingsAvailability'

const ALL_CATEGORIES: readonly SettingsCategory[] = [
  'general',
  'editor',
  'appearance',
  'security',
  'sync',
  'media',
  'location',
  'journals',
  'templates',
  'reminders',
  'ai',
  'data',
]

const GATED_CATEGORIES: readonly SettingsCategory[] = [
  'security',
  'location',
  'reminders',
  'ai',
  'data',
]

// In this (desktop) test environment every flag is true.
const DESKTOP_CAPS: Capabilities = capabilities

// Web build: every flag false — mirrors `capabilities` when isWeb.
const WEB_CAPS: Capabilities = Object.keys(capabilities).reduce<Capabilities>(
  (caps, key) => ({ ...caps, [key]: false }),
  { ...capabilities },
)

describe('isSettingsCategoryAvailable', () => {
  it('desktop: every category is available', () => {
    for (const category of ALL_CATEGORIES) {
      expect(isSettingsCategoryAvailable(category, DESKTOP_CAPS)).toBe(true)
    }
  })

  it('web: gated categories are hidden, ungated ones stay available', () => {
    for (const category of ALL_CATEGORIES) {
      expect(isSettingsCategoryAvailable(category, WEB_CAPS)).toBe(
        !GATED_CATEGORIES.includes(category),
      )
    }
  })

  // Each gated category must key off exactly its own flag — a mix-up
  // (e.g. security gated by `biometric`) would hide it on the wrong build.
  it.each([
    ['ai', 'ai'],
    ['reminders', 'reminders'],
    ['location', 'maps'],
    ['data', 'importExport'],
    ['security', 'vaultAdmin'],
  ] as const)('category %s is gated only by caps.%s', (category, flag) => {
    const caps: Capabilities = { ...WEB_CAPS, [flag]: true }
    for (const gated of GATED_CATEGORIES) {
      expect(isSettingsCategoryAvailable(gated, caps)).toBe(gated === category)
    }
  })
})
