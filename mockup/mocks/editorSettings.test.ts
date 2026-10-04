import { describe, it, expect } from 'vitest'
import { webGetSetting } from './editorSettings'

describe('webGetSetting', () => {
  it('enables editor math, emoji shortcodes, and distraction by default', () => {
    expect(webGetSetting({ key: 'editor_math_enabled' })).toBe('true')
    expect(webGetSetting({ key: 'editor_emoji_shortcodes_enabled' })).toBe('true')
    expect(webGetSetting({ key: 'editor_distraction_enabled' })).toBe('true')
  })

  it('returns null for unknown keys', () => {
    expect(webGetSetting({ key: 'second_lock_show_existence' })).toBeNull()
  })
})
