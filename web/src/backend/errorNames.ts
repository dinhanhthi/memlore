/**
 * Error class names that other modules recognise by `name` instead of `instanceof` (sync.ts must not
 * import the heavy puller / onboard modules into the router bundle). This module imports nothing,
 * so every class and every classifier share one spelling.
 */
export const ERROR_NAMES = {
  vaultLocked: 'VaultLockedError',
  reonboardRequired: 'ReonboardRequiredError',
  formatUnsupported: 'FormatUnsupportedError',
  pullTransient: 'PullTransientError',
  recoveryFence: 'RecoveryFenceError',
  clockSkew: 'ClockSkewError',
} as const
