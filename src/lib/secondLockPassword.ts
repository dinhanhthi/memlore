import { MIN_SECOND_LOCK_PASSWORD_LEN } from './passwordStrength'

export { MIN_SECOND_LOCK_PASSWORD_LEN }

/** Validation outcome as an i18n key suffix — the caller renders the message. */
export type PasswordValidationError = 'too_short' | 'mismatch'

export function validateNewPassword(
  password: string,
  confirm: string,
): PasswordValidationError | null {
  if ([...password].length < MIN_SECOND_LOCK_PASSWORD_LEN) {
    return 'too_short'
  }
  if (password !== confirm) {
    return 'mismatch'
  }
  return null
}
