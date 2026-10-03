import { describe, expect, it } from 'vitest'
import { ERROR_NAMES } from './errorNames'
import { VaultLockedError } from './keys'
import { FormatUnsupportedError } from './sync/onboard'
import { PullTransientError, ReonboardRequiredError } from './sync/pull'

describe('ERROR_NAMES', () => {
  it('matches the name of every error class sync.ts classifies by name', () => {
    expect(new VaultLockedError().name).toBe(ERROR_NAMES.vaultLocked)
    expect(new ReonboardRequiredError('slot-missing').name).toBe(ERROR_NAMES.reonboardRequired)
    expect(new FormatUnsupportedError('control.json', 99).name).toBe(ERROR_NAMES.formatUnsupported)
    expect(new PullTransientError('x').name).toBe(ERROR_NAMES.pullTransient)
  })
})
