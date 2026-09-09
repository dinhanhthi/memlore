import '@testing-library/jest-dom'
import { beforeEach, vi } from 'vitest'
import { i18n } from '../lib/i18n'

// Mock @tauri-apps/api/core so lib/tauri.ts can be imported in jsdom
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

// jsdom does not implement window.matchMedia — provide a stub so components
// that read prefers-reduced-motion don't throw during tests.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

// jsdom does not implement ResizeObserver — provide a no-op shim so components
// that use it don't throw during tests.
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// jsdom does not implement scroll APIs — stub them globally.
window.HTMLElement.prototype.scrollIntoView = function () {}
window.HTMLElement.prototype.scrollTo = function () {}
window.HTMLElement.prototype.scrollBy = function () {}

// jsdom's RAF batches callbacks into a timer that only fires when the event
// loop is idle — it never fires synchronously inside waitFor().  Replace it
// with a version that schedules via Promise (microtask) so callbacks always
// run before the next waitFor interval check.
window.requestAnimationFrame = (cb: FrameRequestCallback) => {
  Promise.resolve().then(() => cb(performance.now()))
  return 0
}

// i18next is a module-level singleton — reset to English before each test so
// tests that switch language (e.g. LanguageSelector) don't leak state into
// snapshot-based tests that assert English copy.
beforeEach(async () => {
  if (i18n.isInitialized && i18n.language !== 'en') {
    await i18n.changeLanguage('en')
  }
})
