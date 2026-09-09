import { describe, expect, it } from 'vitest'
import en from './en/auth.json'
import vi from './vi/auth.json'
import { keyPaths } from './keyParity'

function leaf(bundle: object, path: string): string {
  const value = path.split('.').reduce<unknown>((acc, key) => {
    if (typeof acc !== 'object' || acc === null) return undefined
    return (acc as Record<string, unknown>)[key]
  }, bundle)
  if (typeof value !== 'string') {
    throw new Error(`missing string at ${path}`)
  }
  return value
}

// See `keyParity.ts` for why this test exists and how plural suffixes are
// handled. `auth.json` carries the onboarding wizard + celebration copy,
// which is hand-edited in nested multi-key blocks (e.g. the `setup_sync`
// variant) — exactly the shape that goes one-sided unnoticed.
describe('auth.json en/vi key parity', () => {
  const enKeys = keyPaths(en)
  const viKeys = keyPaths(vi)

  it('has at least one key to compare', () => {
    expect(enKeys.size).toBeGreaterThan(0)
  })

  it('vi has no keys missing from en', () => {
    const missing = [...viKeys].filter((k) => !enKeys.has(k))
    expect(missing).toEqual([])
  })

  it('en has no keys missing from vi', () => {
    const missing = [...enKeys].filter((k) => !viKeys.has(k))
    expect(missing).toEqual([])
  })
})

const PROVIDER_KEYS = [
  'welcome_first_run.existing_cloud_connecting',
  'welcome_first_run.cloud_empty_title',
  'welcome_first_run.cloud_empty_body',
  'welcome_first_run.existing_cloud_error_generic',
  'welcome_first_run.existing_cloud_error_unsafe_setup',
  'welcome_first_run.existing_cloud_error_cloud_vault_exists',
  'onboarding.drive.connect_button',
  'onboarding.drive.connecting',
  'onboarding.drive.connected',
  'onboarding.drive.error_generic',
  'onboarding.drive.background_failed',
] as const

const OAUTH_ONLY_KEYS = [
  'onboarding.drive.progress.exchanging_token',
  'welcome_first_run.existing_cloud_error_pending_session_expired',
] as const

describe('auth.json cloud-provider interpolation', () => {
  it('adds onboarding.drive.picker_hint in both locales', () => {
    expect(leaf(en, 'onboarding.drive.picker_hint').length).toBeGreaterThan(0)
    expect(leaf(vi, 'onboarding.drive.picker_hint').length).toBeGreaterThan(0)
  })

  it('interpolates {{provider}} on welcome + drive connect copy', () => {
    for (const path of PROVIDER_KEYS) {
      expect(leaf(en, path), path).toContain('{{provider}}')
      expect(leaf(vi, path), path).toContain('{{provider}}')
    }
  })

  it('keeps OAuth-only Google strings without {{provider}}', () => {
    for (const path of OAUTH_ONLY_KEYS) {
      const enValue = leaf(en, path)
      const viValue = leaf(vi, path)
      expect(enValue, path).toMatch(/Google/)
      expect(enValue, path).not.toContain('{{provider}}')
      expect(viValue, path).toMatch(/Google/)
      expect(viValue, path).not.toContain('{{provider}}')
    }
  })

  it('rewrites the drive-step title as provider-neutral', () => {
    expect(leaf(en, 'onboarding.drive.title')).toBe('Sync with a cloud service')
    expect(leaf(en, 'onboarding.drive.title')).not.toMatch(/Google/)
    expect(leaf(vi, 'onboarding.drive.title')).not.toMatch(/Google/)
  })
})
