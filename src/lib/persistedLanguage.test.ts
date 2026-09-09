import { describe, it, expect, beforeEach } from 'vitest'
import { UI_STORAGE_KEY, readPersistedLanguage } from './persistedLanguage'
import { useUiStore } from '../stores/uiStore'

describe('readPersistedLanguage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('reads back what the real uiStore persists (writer/reader cross-path)', () => {
    useUiStore.getState().setUiLanguage('vi')
    expect(readPersistedLanguage()).toBe('vi')
  })

  it('returns the persisted language when it is supported', () => {
    localStorage.setItem(
      UI_STORAGE_KEY,
      JSON.stringify({ state: { uiLanguage: 'vi' }, version: 0 }),
    )
    expect(readPersistedLanguage()).toBe('vi')
  })

  it('falls back to the default when the key is absent', () => {
    expect(readPersistedLanguage()).toBe('en')
  })

  it('falls back to the default on non-JSON garbage', () => {
    localStorage.setItem(UI_STORAGE_KEY, 'not-json{{{')
    expect(readPersistedLanguage()).toBe('en')
  })

  it('falls back to the default when the parsed JSON has no `state`', () => {
    localStorage.setItem(UI_STORAGE_KEY, JSON.stringify({ version: 0 }))
    expect(readPersistedLanguage()).toBe('en')
  })

  it('falls back to the default when `state` has no `uiLanguage`', () => {
    localStorage.setItem(UI_STORAGE_KEY, JSON.stringify({ state: { theme: 'dark' }, version: 0 }))
    expect(readPersistedLanguage()).toBe('en')
  })

  it('falls back to the default when `uiLanguage` is unsupported', () => {
    localStorage.setItem(
      UI_STORAGE_KEY,
      JSON.stringify({ state: { uiLanguage: 'fr' }, version: 0 }),
    )
    expect(readPersistedLanguage()).toBe('en')
  })
})
