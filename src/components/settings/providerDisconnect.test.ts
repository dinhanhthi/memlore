import { describe, expect, it } from 'vitest'
import {
  disconnectConfirmCopy,
  disconnectWipesCredential,
  hasCredentialSurface,
} from './providerDisconnect'

/** The merged card key the Providers tab used before the on-device split.
 *  Kept as a regression fixture: it is not a preset id, so it must never be
 *  classified as credentialed. */
const SYNTHETIC_CARD_KEY = 'integrated'

const DESTRUCTIVE = {
  titleKey: 'action.forget_confirm_title',
  bodyKey: 'action.forget_confirm_body',
}
const SOFT = {
  titleKey: 'providers_tab.disconnect_confirm_title',
  bodyKey: 'providers_tab.disconnect_confirm_body',
}

describe('hasCredentialSurface', () => {
  it.each(['openai', 'anthropic', 'gemini', 'voyage', 'custom', 'ollama'])(
    'reports %s as credentialed',
    (id) => {
      expect(hasCredentialSurface(id)).toBe(true)
    },
  )

  it.each(['claude-cli', 'codex-cli'])('reports CLI preset %s as non-credentialed', (id) => {
    expect(hasCredentialSurface(id)).toBe(false)
  })

  it.each(['on-device', 'on-device-llm'])(
    'reports on-device preset %s as non-credentialed',
    (id) => {
      expect(hasCredentialSurface(id)).toBe(false)
    },
  )

  // Regression: a synthetic card key passes both the subprocess and
  // on-device checks (it is neither), so without the preset-existence guard
  // it was misreported as credentialed and the confirm dialog claimed a key
  // wipe for a provider that has no key.
  it('reports a synthetic card key as non-credentialed', () => {
    expect(hasCredentialSurface(SYNTHETIC_CARD_KEY)).toBe(false)
  })

  it('reports an unknown key as non-credentialed', () => {
    expect(hasCredentialSurface('not-a-real-preset')).toBe(false)
  })
})

describe('disconnectConfirmCopy', () => {
  it('uses the destructive copy for credentialed presets', () => {
    expect(disconnectConfirmCopy('openai')).toEqual(DESTRUCTIVE)
  })

  it.each(['claude-cli', 'codex-cli', 'on-device', 'on-device-llm', SYNTHETIC_CARD_KEY])(
    'uses the non-destructive copy for %s',
    (key) => {
      expect(disconnectConfirmCopy(key)).toEqual(SOFT)
    },
  )

  // The defect this module exists to prevent: title and body must never
  // come from different predicates.
  it.each(['openai', 'claude-cli', SYNTHETIC_CARD_KEY, 'unknown-key'])(
    'keeps title and body in agreement for %s',
    (key) => {
      const copy = disconnectConfirmCopy(key)
      const wipes = disconnectWipesCredential(key)
      expect(copy).toEqual(wipes ? DESTRUCTIVE : SOFT)
    },
  )
})
