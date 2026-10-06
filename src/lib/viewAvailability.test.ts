import { describe, expect, it } from 'vitest'
import type { ActiveView } from '../stores/uiStore'
import { capabilities, type Capabilities } from './platform'
import { isViewAvailable } from './viewAvailability'

const ALL_VIEWS: readonly ActiveView[] = [
  'dashboard',
  'entries',
  'tags',
  'calendar',
  'search',
  'settings',
  'onthisday',
  'media',
  'map',
  'stats',
  'chat',
  'about',
]

const GATED_VIEWS: readonly ActiveView[] = [
  'dashboard',
  'stats',
  'media',
  'onthisday',
  'map',
  'chat',
]

// In this (desktop) test environment every flag is true.
const DESKTOP_CAPS: Capabilities = capabilities

// Web build: every flag false — mirrors `capabilities` when isWeb.
const WEB_CAPS: Capabilities = Object.keys(capabilities).reduce<Capabilities>(
  (caps, key) => ({ ...caps, [key]: false }),
  { ...capabilities },
)

describe('isViewAvailable', () => {
  it('desktop: every view is available', () => {
    for (const view of ALL_VIEWS) {
      expect(isViewAvailable(view, DESKTOP_CAPS)).toBe(true)
    }
  })

  it('web: gated views are unavailable, ungated ones stay available', () => {
    for (const view of ALL_VIEWS) {
      expect(isViewAvailable(view, WEB_CAPS)).toBe(!GATED_VIEWS.includes(view))
    }
  })

  it('defaults to the platform capabilities', () => {
    for (const view of ALL_VIEWS) {
      expect(isViewAvailable(view)).toBe(true)
    }
  })

  // Each gated view must key off exactly its own flag — a mix-up
  // (e.g. media gated by `fileAttachments`) would hide it on the wrong build.
  it.each([
    ['dashboard', 'dashboard'],
    ['stats', 'stats'],
    ['media', 'gallery'],
    ['onthisday', 'lookback'],
    ['map', 'maps'],
  ] as const)('view %s is gated only by caps.%s', (view, flag) => {
    const caps: Capabilities = { ...WEB_CAPS, [flag]: true }
    for (const gated of GATED_VIEWS) {
      expect(isViewAvailable(gated, caps)).toBe(gated === view)
    }
  })

  // Chat needs BOTH ai and chat — either flag alone leaves it unavailable.
  it.each([['ai'], ['chat']] as const)('view chat stays unavailable with only caps.%s', (flag) => {
    const caps: Capabilities = { ...WEB_CAPS, [flag]: true }
    expect(isViewAvailable('chat', caps)).toBe(false)
  })

  it('view chat is available only when caps.ai && caps.chat', () => {
    const caps: Capabilities = { ...WEB_CAPS, ai: true, chat: true }
    for (const gated of GATED_VIEWS) {
      expect(isViewAvailable(gated, caps)).toBe(gated === 'chat')
    }
  })
})
