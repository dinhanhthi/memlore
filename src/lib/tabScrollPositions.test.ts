import { describe, it, expect, beforeEach } from 'vitest'
import {
  tabScrollKey,
  getTabScroll,
  setTabScroll,
  clearTabScroll,
  isScrollPortUsable,
  applySavedScroll,
} from './tabScrollPositions'

beforeEach(() => {
  clearTabScroll()
})

describe('tabScrollKey', () => {
  it('builds tabId:view when no sub is given', () => {
    expect(tabScrollKey('tab-1', 'entries')).toBe('tab-1:entries')
  })

  it('builds tabId:view:sub when a sub is given', () => {
    expect(tabScrollKey('tab-1', 'editor', 'entry-9')).toBe('tab-1:editor:entry-9')
  })
})

describe('setTabScroll / getTabScroll', () => {
  it('stores and returns a scroll position', () => {
    setTabScroll('tab-1:entries', 240)
    expect(getTabScroll('tab-1:entries')).toBe(240)
  })

  it('overwrites an existing key', () => {
    setTabScroll('tab-1:entries', 100)
    setTabScroll('tab-1:entries', 320)
    expect(getTabScroll('tab-1:entries')).toBe(320)
  })

  it('returns undefined for a missing key', () => {
    expect(getTabScroll('missing')).toBeUndefined()
  })
})

describe('clearTabScroll', () => {
  it('clears a single key when given', () => {
    setTabScroll('a', 10)
    setTabScroll('b', 20)
    clearTabScroll('a')
    expect(getTabScroll('a')).toBeUndefined()
    expect(getTabScroll('b')).toBe(20)
  })

  it('clears the whole map when no key is given', () => {
    setTabScroll('a', 10)
    setTabScroll('b', 20)
    clearTabScroll()
    expect(getTabScroll('a')).toBeUndefined()
    expect(getTabScroll('b')).toBeUndefined()
  })
})

function makePort(opts: {
  clientHeight: number
  scrollHeight: number
  display?: string
  scrollTop?: number
}): HTMLDivElement {
  const el = document.createElement('div')
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: opts.clientHeight })
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: 300 })
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: opts.scrollHeight })
  if (opts.display) el.style.display = opts.display
  el.scrollTop = opts.scrollTop ?? 0
  return el
}

describe('isScrollPortUsable', () => {
  it('is false when the box has no size', () => {
    expect(isScrollPortUsable(makePort({ clientHeight: 0, scrollHeight: 0 }))).toBe(false)
  })

  it('is false when display is none', () => {
    const el = makePort({ clientHeight: 400, scrollHeight: 2000, display: 'none' })
    expect(isScrollPortUsable(el)).toBe(false)
  })

  it('is true for a visible overflow port', () => {
    expect(isScrollPortUsable(makePort({ clientHeight: 400, scrollHeight: 2000 }))).toBe(true)
  })
})

describe('applySavedScroll', () => {
  it('does not write scrollTop when the port is not yet tall enough', () => {
    const el = makePort({ clientHeight: 400, scrollHeight: 400, scrollTop: 0 })
    expect(applySavedScroll(el, 300)).toBe(false)
    expect(el.scrollTop).toBe(0)
  })

  it('does not write scrollTop when the port is hidden', () => {
    const el = makePort({ clientHeight: 400, scrollHeight: 2000, display: 'none', scrollTop: 0 })
    expect(applySavedScroll(el, 300)).toBe(false)
    expect(el.scrollTop).toBe(0)
  })

  it('applies saved once the port can hold it', () => {
    const el = makePort({ clientHeight: 400, scrollHeight: 2000, scrollTop: 0 })
    expect(applySavedScroll(el, 300)).toBe(true)
    expect(el.scrollTop).toBe(300)
  })
})
