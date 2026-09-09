export type JournalLockDecision = 'prompt-enable' | 'lock' | 'prompt-unlock' | 'unlock' | 'reject'

/**
 * Lock/unlock click + verify decision. Unlock only after
 * `verifyPassword` resolves true — a wrong password never yields `'unlock'`.
 */
export function decideJournalLock(input: {
  secondLockEnabled: boolean
  isLocked: boolean
  passwordVerified: boolean | null
}): JournalLockDecision {
  if (!input.secondLockEnabled) return 'prompt-enable'
  if (!input.isLocked) return 'lock'
  if (input.passwordVerified === true) return 'unlock'
  if (input.passwordVerified === false) return 'reject'
  return 'prompt-unlock'
}
