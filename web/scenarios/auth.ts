import type { Scenario } from './types'

/** Session id forwarded to onboard_* mocks in the web preview harness. */
export const WEB_PREVIEW_ONBOARD_SESSION_ID = 'web-preview-onboard-session'

/** Invoke overrides for OnboardNewDeviceScreen preview scenarios. */
export const onboardNewDeviceInvoke: NonNullable<Scenario['invoke']> = {
  get_encryption_mode: 'unset',
  is_encryption_initialized: false,
  get_force_re_pair_status: null,
  gdrive_get_status: { connected: false },
  gdrive_disconnect: null,
  onboard_validate_passphrase: null,
  onboard_complete: null,
  // The join flow's unlock-method step probes this; true so the preview shows
  // both pills rather than the password-only degradation.
  is_biometric_available: true,
}
