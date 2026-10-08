import { describe, expect, it } from 'vitest'
import type { ActiveView } from '../stores/uiStore'
import { capabilities, type Capabilities } from './platform'
import { isViewAvailable, needsMonthIndex } from './viewAvailability'

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

// Every flag false — the baseline the per-flag tests switch one flag on from.
const NO_CAPS: Capabilities = Object.keys(capabilities).reduce<Capabilities>(
  (caps, key) => ({ ...caps, [key]: false }),
  { ...capabilities },
)

// Web build: mirrors `capabilities` when isWeb — every desktop-only flag false,
// the read-only flags that hold on both platforms true.
const WEB_CAPS: Capabilities = {
  ...NO_CAPS,
  chatRead: true,
  memoryRead: true,
  streak: true,
  entryMarkdownExport: true,
}

// Views with no web implementation; Daily Chat is available read-only.
const WEB_HIDDEN_VIEWS: readonly ActiveView[] = GATED_VIEWS.filter((v) => v !== 'chat')

describe('isViewAvailable', () => {
  it('desktop: every view is available', () => {
    for (const view of ALL_VIEWS) {
      expect(isViewAvailable(view, DESKTOP_CAPS)).toBe(true)
    }
  })

  it('web: daily chat is available read-only, the other gated views stay hidden', () => {
    for (const view of ALL_VIEWS) {
      expect(isViewAvailable(view, WEB_CAPS)).toBe(!WEB_HIDDEN_VIEWS.includes(view))
    }
  })

  it('web: gallery and lookback open once a desktop publishes the month index', () => {
    const caps: Capabilities = { ...WEB_CAPS, gallery: true, lookback: true }
    expect(isViewAvailable('media', caps)).toBe(true)
    expect(isViewAvailable('onthisday', caps)).toBe(true)
  })

  it('web: chat is available while ai stays false', () => {
    expect(WEB_CAPS.ai).toBe(false)
    expect(isViewAvailable('chat', WEB_CAPS)).toBe(true)
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
    ['map', 'mapView'],
    ['chat', 'chatRead'],
  ] as const)('view %s is gated only by caps.%s', (view, flag) => {
    const caps: Capabilities = { ...NO_CAPS, [flag]: true }
    for (const gated of GATED_VIEWS) {
      expect(isViewAvailable(gated, caps)).toBe(gated === view)
    }
  })

  // `maps` gates location/weather writes, not the map view.
  it('view map stays unavailable with only caps.maps', () => {
    expect(isViewAvailable('map', { ...NO_CAPS, maps: true })).toBe(false)
  })

  // Reading chats needs no AI: `ai` and `chat` alone never open the view.
  it.each([['ai'], ['chat']] as const)('view chat stays unavailable with only caps.%s', (flag) => {
    const caps: Capabilities = { ...NO_CAPS, [flag]: true }
    expect(isViewAvailable('chat', caps)).toBe(false)
  })
})

describe('needsMonthIndex', () => {
  it('names the views a desktop month index unlocks on web', () => {
    for (const view of ALL_VIEWS) {
      expect(needsMonthIndex(view)).toBe(view === 'media' || view === 'onthisday')
    }
  })
})
