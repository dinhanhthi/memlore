import { describe, it, expect } from 'vitest'
import { resolveEmojiShortcode, searchEmojiShortcodes } from './emojiShortcodes'

describe('resolveEmojiShortcode', () => {
  it('resolves an exact keyword token', () => {
    expect(resolveEmojiShortcode('grinning')).toBe('😀')
    expect(resolveEmojiShortcode('rofl')).toBe('🤣')
  })

  it('is case-insensitive', () => {
    expect(resolveEmojiShortcode('GRINNING')).toBe('😀')
  })

  it('returns null for unknown shortcodes', () => {
    expect(resolveEmojiShortcode('not-a-real-shortcode')).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(resolveEmojiShortcode('')).toBeNull()
    expect(resolveEmojiShortcode('   ')).toBeNull()
  })
})

describe('searchEmojiShortcodes', () => {
  it('returns empty results for an empty query', () => {
    expect(searchEmojiShortcodes('')).toEqual([])
    expect(searchEmojiShortcodes('   ')).toEqual([])
  })

  it('matches keyword prefixes', () => {
    const results = searchEmojiShortcodes('smi')
    expect(results.length).toBeGreaterThan(0)
    expect(results.some((r) => r.shortcode.startsWith('smi'))).toBe(true)
  })

  it('deduplicates by emoji character', () => {
    const results = searchEmojiShortcodes('smi', 50)
    expect(new Set(results.map((r) => r.char)).size).toBe(results.length)
  })

  it('respects the result limit', () => {
    expect(searchEmojiShortcodes('a', 3)).toHaveLength(3)
  })
})
