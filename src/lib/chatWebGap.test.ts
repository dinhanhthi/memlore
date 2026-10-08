import { describe, expect, it } from 'vitest'
import { chatWebGapFromError, chatWebGapOf } from './chatWebGap'

describe('chatWebGapOf', () => {
  it('is null without flags', () => {
    expect(chatWebGapOf(null)).toBeNull()
    expect(chatWebGapOf(undefined)).toBeNull()
    expect(chatWebGapOf({})).toBeNull()
  })

  it('maps each flag to its gap', () => {
    expect(chatWebGapOf({ tooLargeForWeb: true })).toBe('too_large_for_web')
    expect(chatWebGapOf({ unreadableOnWeb: true })).toBe('unreadable_on_web')
  })

  it('prefers too-large when both flags are set', () => {
    expect(chatWebGapOf({ tooLargeForWeb: true, unreadableOnWeb: true })).toBe('too_large_for_web')
  })
})

describe('chatWebGapFromError', () => {
  it('reads the code from an Error or a string', () => {
    expect(chatWebGapFromError(new Error('too_large_for_web: open this on a desktop'))).toBe(
      'too_large_for_web',
    )
    expect(chatWebGapFromError('unreadable_on_web: open this on a desktop')).toBe(
      'unreadable_on_web',
    )
  })

  it('is null for any other error', () => {
    expect(chatWebGapFromError(new Error('AI_DAILY_CHAT_SESSION_NOT_FOUND'))).toBeNull()
    expect(chatWebGapFromError(undefined)).toBeNull()
  })
})
