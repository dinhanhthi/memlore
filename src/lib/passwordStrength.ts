import { zxcvbn, zxcvbnOptions } from '@zxcvbn-ts/core'
import * as zxcvbnCommonPackage from '@zxcvbn-ts/language-common'
import * as zxcvbnEnPackage from '@zxcvbn-ts/language-en'

export const MIN_PASSWORD_LEN = 8

/**
 * Minimum length for the second-lock password.
 *
 * The second lock is an extra in-app visibility gate behind the master
 * password, not a separate encryption layer, so it intentionally has a lower
 * floor than `MIN_PASSWORD_LEN`. Any characters are allowed; length is counted
 * in Unicode code points (e.g. `[...pw].length`).
 */
export const MIN_SECOND_LOCK_PASSWORD_LEN = 4

export type Strength = 'weak' | 'fair' | 'good' | 'strong'

let configured = false
function ensureConfigured(): void {
  if (configured) return
  zxcvbnOptions.setOptions({
    translations: zxcvbnEnPackage.translations,
    graphs: zxcvbnCommonPackage.adjacencyGraphs,
    dictionary: {
      ...zxcvbnCommonPackage.dictionary,
      ...zxcvbnEnPackage.dictionary,
    },
  })
  configured = true
}

function countCodePoints(s: string): number {
  return [...s].length
}

/**
 * Estimate password strength using zxcvbn-ts (pattern/dictionary-aware entropy model).
 *
 * Maps the library's 0–4 score onto our four-level UI scale and enforces the
 * project minimum length as a hard floor:
 *   - length < MIN_PASSWORD_LEN → 'weak' (regardless of zxcvbn score)
 *   - score 0 or 1               → 'weak'
 *   - score 2                    → 'fair'
 *   - score 3                    → 'good'
 *   - score 4                    → 'strong'
 */
export function passwordStrength(pw: string): Strength {
  if (countCodePoints(pw) < MIN_PASSWORD_LEN) return 'weak'
  ensureConfigured()
  const { score } = zxcvbn(pw)
  if (score <= 1) return 'weak'
  if (score === 2) return 'fair'
  if (score === 3) return 'good'
  return 'strong'
}
