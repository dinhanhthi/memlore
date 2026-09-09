import { describe, expect, it } from 'vitest'
import { decideJournalLock } from './journalLockDecision'

describe('decideJournalLock', () => {
  it('never yields unlock when the password is wrong', () => {
    expect(
      decideJournalLock({
        secondLockEnabled: true,
        isLocked: true,
        passwordVerified: false,
      }),
    ).toBe('reject')
  })

  it('unlocks only after verifyPassword resolves true', () => {
    expect(
      decideJournalLock({
        secondLockEnabled: true,
        isLocked: true,
        passwordVerified: true,
      }),
    ).toBe('unlock')
  })

  it('locks an unlocked journal without a password', () => {
    expect(
      decideJournalLock({
        secondLockEnabled: true,
        isLocked: false,
        passwordVerified: null,
      }),
    ).toBe('lock')
  })

  it('prompts for the password instead of unlocking on click', () => {
    expect(
      decideJournalLock({
        secondLockEnabled: true,
        isLocked: true,
        passwordVerified: null,
      }),
    ).toBe('prompt-unlock')
  })

  it('prompts to enable the second lock when it is off', () => {
    expect(
      decideJournalLock({
        secondLockEnabled: false,
        isLocked: false,
        passwordVerified: null,
      }),
    ).toBe('prompt-enable')
  })
})
