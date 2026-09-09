import { describe, expect, it } from 'vitest'
import { MIN_SECOND_LOCK_PASSWORD_LEN, validateNewPassword } from './secondLockPassword'

describe('validateNewPassword', () => {
  it('exports a 4-character floor', () => {
    expect(MIN_SECOND_LOCK_PASSWORD_LEN).toBe(4)
  })

  it('rejects 3 characters even when confirm matches', () => {
    expect(validateNewPassword('abc', 'abc')).toBe('too_short')
  })

  it('accepts 4 matching characters', () => {
    expect(validateNewPassword('abcd', 'abcd')).toBeNull()
  })

  it('rejects a mismatch at a valid length', () => {
    expect(validateNewPassword('abcd', 'abce')).toBe('mismatch')
  })
})
