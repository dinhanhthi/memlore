import { describe, expect, it } from 'vitest'
import { getPreset } from '../types/ai'
import type { ProviderCredential } from '../types/ai'
import {
  buildConnectedProviderOptions,
  classifyMemoryPresetGroup,
  isProviderConnected,
  memoryPresetDisabledReason,
  presetNeedsApiKey,
  providerIsConfigured,
  requiresHostedAck,
  modelsTabDotColor,
  providersTabDotColor,
  resolveAiSetupAttention,
  resolveSetupPrivacyReceipt,
  isAiSetupAttentionReady,
  resolveProbeModel,
  slotDotColor,
  slotIsConnected,
  worstSlotStatusColor,
} from './aiProviderStatus'

function credential(
  overrides: Partial<ProviderCredential> & { presetId: string },
): ProviderCredential {
  return {
    endpoint: '',
    hasApiKey: false,
    endpointClass: 'local',
    ...overrides,
  }
}

describe('resolveProbeModel', () => {
  it('resolves the chat suggestion for a chat-capable hosted preset', () => {
    const preset = getPreset('openai')
    expect(preset).toBeDefined()
    const resolution = resolveProbeModel(preset!)
    expect(resolution).toEqual({
      probeModel: preset!.chatModelSuggestions?.[0]?.value,
      capability: undefined,
    })
    expect(resolution.probeModel).toBeTruthy()
  })

  it('resolves the embedding suggestion + capability for the embed-only voyage preset', () => {
    const preset = getPreset('voyage')
    expect(preset).toBeDefined()
    const resolution = resolveProbeModel(preset!)
    expect(resolution).toEqual({
      probeModel: preset!.embeddingModelSuggestions?.[0]?.value,
      capability: 'embed',
    })
    expect(resolution.probeModel).toBeTruthy()
  })

  it('returns an undefined probeModel for a preset with no suggestion list', () => {
    const preset = getPreset('custom')
    expect(preset).toBeDefined()
    expect(preset!.chatModelSuggestions).toBeUndefined()
    expect(resolveProbeModel(preset!)).toEqual({ probeModel: undefined, capability: undefined })
  })
})

describe('presetNeedsApiKey', () => {
  it('is true for a hosted preset with no API key on file', () => {
    expect(presetNeedsApiKey('openai', false)).toBe(true)
  })

  it('is false for a hosted preset that has an API key on file', () => {
    expect(presetNeedsApiKey('openai', true)).toBe(false)
  })

  it('is false for keyless-usable presets (local / CLI / on-device) even with no key', () => {
    expect(presetNeedsApiKey('ollama', false)).toBe(false)
    expect(presetNeedsApiKey('claude-cli', false)).toBe(false)
    expect(presetNeedsApiKey('on-device', false)).toBe(false)
    expect(presetNeedsApiKey('on-device-llm', false)).toBe(false)
  })

  it('is false for an unknown preset id', () => {
    expect(presetNeedsApiKey('not-a-real-preset', false)).toBe(false)
  })
})

describe('memoryPresetDisabledReason', () => {
  it('is null for a local preset with no key required', () => {
    expect(memoryPresetDisabledReason('ollama', false, 'local', false)).toBeNull()
  })

  it('is "hosted_blocked" for a remote-class preset when hosted memory is not allowed, regardless of key', () => {
    expect(memoryPresetDisabledReason('openai', true, 'remote', false)).toBe('hosted_blocked')
    expect(memoryPresetDisabledReason('openai', false, 'remote', false)).toBe('hosted_blocked')
  })

  it('is "hosted_blocked" for a subscription-class (CLI) preset when hosted memory is not allowed', () => {
    expect(memoryPresetDisabledReason('claude-cli', false, 'subscription', false)).toBe(
      'hosted_blocked',
    )
  })

  it('is null for a remote-class preset with a key once hosted memory is allowed', () => {
    expect(memoryPresetDisabledReason('openai', true, 'remote', true)).toBeNull()
  })

  it('falls through to "needs_key" once hosted memory is allowed but no key is on file', () => {
    expect(memoryPresetDisabledReason('openai', false, 'remote', true)).toBe('needs_key')
  })

  it('never disables a keyless on-device preset', () => {
    expect(memoryPresetDisabledReason('on-device', false, 'on-device', true)).toBeNull()
    expect(memoryPresetDisabledReason('on-device', false, 'on-device', false)).toBeNull()
  })

  // T5.2 headline scenario: `custom` (catalog `group: 'hosted'`, but its
  // resolved `endpointClass` depends on where the user actually pointed
  // it) must be gated on the DERIVED class, not the static catalog group —
  // selectable at a loopback endpoint, blocked at a remote one. `custom`
  // also has `requiresApiKey: true` in the catalog, so a missing key still
  // wins as `'needs_key'` regardless of endpoint class — these pin the
  // local-vs-remote distinction with that requirement held constant.
  it('for `custom`: selectable at a loopback (local-class) endpoint once a key is on file, even with hosted memory disallowed', () => {
    expect(memoryPresetDisabledReason('custom', true, 'local', false)).toBeNull()
  })

  it('for `custom`: still needs a key at a loopback endpoint — endpoint class alone does not exempt it', () => {
    expect(memoryPresetDisabledReason('custom', false, 'local', false)).toBe('needs_key')
  })

  it('for `custom`: blocked at a remote endpoint while hosted memory is disallowed, even with a key on file', () => {
    expect(memoryPresetDisabledReason('custom', true, 'remote', false)).toBe('hosted_blocked')
  })

  it('for `custom`: selectable at a remote endpoint once both a key is on file and hosted memory is allowed', () => {
    expect(memoryPresetDisabledReason('custom', true, 'remote', true)).toBeNull()
  })
})

describe('requiresHostedAck', () => {
  it('is true for remote (hosted HTTP)', () => {
    expect(requiresHostedAck('remote')).toBe(true)
  })

  it('is true for subscription (CLI) — same as a hosted preset, data still leaves the machine', () => {
    expect(requiresHostedAck('subscription')).toBe(true)
  })

  it('is false for local', () => {
    expect(requiresHostedAck('local')).toBe(false)
  })

  it('is false for on-device', () => {
    expect(requiresHostedAck('on-device')).toBe(false)
  })

  it('is false for null/undefined (fail-open default before credentials load)', () => {
    expect(requiresHostedAck(null)).toBe(false)
    expect(requiresHostedAck(undefined)).toBe(false)
  })
})

describe('classifyMemoryPresetGroup', () => {
  it('groups subscription-class (CLI) presets under "subscription"', () => {
    expect(classifyMemoryPresetGroup('subscription')).toBe('subscription')
  })

  it('groups remote-class presets under "hosted"', () => {
    expect(classifyMemoryPresetGroup('remote')).toBe('hosted')
  })

  it('groups local-class presets under "local"', () => {
    expect(classifyMemoryPresetGroup('local')).toBe('local')
  })

  it('groups on-device under "local" alongside other on-machine options', () => {
    expect(classifyMemoryPresetGroup('on-device')).toBe('local')
  })

  it('falls back to "local" for null/undefined', () => {
    expect(classifyMemoryPresetGroup(null)).toBe('local')
    expect(classifyMemoryPresetGroup(undefined)).toBe('local')
  })
})

describe('isProviderConnected', () => {
  it('is true when the preset is in addedProviders even without a credential', () => {
    expect(isProviderConnected('claude-cli', undefined, ['claude-cli'], false)).toBe(true)
  })

  it('is true for a hosted preset with an API key on file', () => {
    expect(
      isProviderConnected(
        'openai',
        credential({
          presetId: 'openai',
          endpoint: getPreset('openai')!.endpoint,
          hasApiKey: true,
          endpointClass: 'remote',
        }),
        [],
        false,
      ),
    ).toBe(true)
  })

  it('is false for a never-touched ollama row (catalog default is not a connection)', () => {
    expect(
      isProviderConnected(
        'ollama',
        credential({
          presetId: 'ollama',
          endpoint: getPreset('ollama')!.endpoint,
          endpointClass: 'local',
        }),
        [],
        false,
      ),
    ).toBe(false)
  })

  it('is true for on-device when a model is downloaded', () => {
    expect(isProviderConnected('on-device-llm', undefined, [], true)).toBe(true)
  })

  it('is false for an on-device preset in addedProviders with no model downloaded', () => {
    expect(isProviderConnected('on-device-llm', undefined, ['on-device-llm'], false)).toBe(false)
    expect(isProviderConnected('on-device', undefined, ['on-device'], false)).toBe(false)
  })

  it('is true for an on-device preset in addedProviders once a model is downloaded', () => {
    expect(isProviderConnected('on-device-llm', undefined, ['on-device-llm'], true)).toBe(true)
    expect(isProviderConnected('on-device', undefined, ['on-device'], true)).toBe(true)
  })
})

describe('slotIsConnected', () => {
  const credMap = (...creds: ProviderCredential[]) => new Map(creds.map((c) => [c.presetId, c]))

  it('is false when the slot is unset', () => {
    expect(slotIsConnected(null, new Map(), [], false)).toBe(false)
  })

  // The regression this helper exists for: a device that adopted an existing
  // cloud vault gets `ai_gen_provider` / `ai_embed_provider` (and their model
  // rows) via settings sync, but never the keyring — so every slot hydrates
  // non-null and unusable.
  it('is false for a synced hosted slot with no API key on this device', () => {
    expect(
      slotIsConnected(
        { provider: 'openai', hasApiKey: false },
        credMap(
          credential({
            presetId: 'openai',
            endpoint: getPreset('openai')!.endpoint,
            endpointClass: 'remote',
          }),
        ),
        [],
        false,
      ),
    ).toBe(false)
  })

  // `ai_provider_endpoints` DOES sync, so the override alone would satisfy
  // `isProviderConnected` — the key check has to close that hole.
  it('is false for a hosted slot whose endpoint override synced but key did not', () => {
    expect(
      slotIsConnected(
        { provider: 'openai', hasApiKey: false },
        credMap(
          credential({
            presetId: 'openai',
            endpoint: 'https://proxy.example.com/v1',
            endpointClass: 'remote',
          }),
        ),
        [],
        false,
      ),
    ).toBe(false)
  })

  // Keyless presets pass `presetNeedsApiKey`, so `isProviderConnected` is the
  // only thing standing between a synced slot and a false "ready".
  it('is false for a synced on-device slot with no model downloaded', () => {
    expect(slotIsConnected({ provider: 'on-device', hasApiKey: false }, new Map(), [], false)).toBe(
      false,
    )
  })

  it('is false for a synced ollama slot with no endpoint override on file', () => {
    expect(
      slotIsConnected(
        { provider: 'ollama', hasApiKey: false },
        credMap(
          credential({
            presetId: 'ollama',
            endpoint: getPreset('ollama')!.endpoint,
            endpointClass: 'local',
          }),
        ),
        [],
        false,
      ),
    ).toBe(false)
  })

  it('is true for a hosted slot with a key on file', () => {
    expect(
      slotIsConnected(
        { provider: 'openai', hasApiKey: true },
        credMap(
          credential({
            presetId: 'openai',
            endpoint: getPreset('openai')!.endpoint,
            hasApiKey: true,
            endpointClass: 'remote',
          }),
        ),
        [],
        false,
      ),
    ).toBe(true)
  })

  it('is true for an on-device slot once a model is downloaded', () => {
    expect(slotIsConnected({ provider: 'on-device', hasApiKey: false }, new Map(), [], true)).toBe(
      true,
    )
  })

  it('is true for a CLI slot the user explicitly added', () => {
    expect(
      slotIsConnected(
        { provider: 'claude-cli', hasApiKey: false },
        new Map(),
        ['claude-cli'],
        false,
      ),
    ).toBe(true)
  })

  it('is false for an undefined slot (not just null)', () => {
    expect(slotIsConnected(undefined, new Map(), [], false)).toBe(false)
  })

  it('is false for embed-only voyage without a key', () => {
    expect(slotIsConnected({ provider: 'voyage', hasApiKey: false }, new Map(), [], false)).toBe(
      false,
    )
  })

  it('is false for on-device-llm with only the embed catalog downloaded', () => {
    // The caller passes the readiness of the matching catalog; a downloaded
    // EMBED model must not make the chat slot look ready.
    expect(
      slotIsConnected({ provider: 'on-device-llm', hasApiKey: false }, new Map(), [], false),
    ).toBe(false)
  })

  it('is false for a keyless custom preset even with an endpoint override', () => {
    // `custom` declares `requiresApiKey: true`, so an endpoint alone is not a
    // connection. Pinned deliberately — `other-local` is the keyless path.
    expect(
      slotIsConnected(
        { provider: 'custom', hasApiKey: false },
        credMap(
          credential({
            presetId: 'custom',
            endpoint: 'http://127.0.0.1:8080/v1',
            endpointClass: 'local',
          }),
        ),
        [],
        false,
      ),
    ).toBe(false)
  })

  it('fails closed when the slot snapshot and the credential row disagree', () => {
    // Two sources of truth for one fact: `isProviderConnected` reads the
    // registry row, `presetNeedsApiKey` reads the slot snapshot. Either one
    // reporting "no key" must disable the slot.
    expect(
      slotIsConnected(
        { provider: 'openai', hasApiKey: true },
        credMap(
          credential({
            presetId: 'openai',
            endpoint: getPreset('openai')!.endpoint,
            hasApiKey: false,
            endpointClass: 'remote',
          }),
        ),
        [],
        false,
      ),
    ).toBe(false)
    expect(
      slotIsConnected(
        { provider: 'openai', hasApiKey: false },
        credMap(
          credential({
            presetId: 'openai',
            endpoint: getPreset('openai')!.endpoint,
            hasApiKey: true,
            endpointClass: 'remote',
          }),
        ),
        [],
        false,
      ),
    ).toBe(false)
  })

  it('is true for an ollama slot with a real endpoint override', () => {
    expect(
      slotIsConnected(
        { provider: 'ollama', hasApiKey: false },
        credMap(
          credential({
            presetId: 'ollama',
            endpoint: 'http://192.168.1.50:11434/v1',
            endpointClass: 'local',
          }),
        ),
        [],
        false,
      ),
    ).toBe(true)
  })
})

describe('slotDotColor / worstSlotStatusColor', () => {
  it('marks a chosen-but-not-connected slot as warning', () => {
    expect(
      slotDotColor({ provider: 'openai', hasApiKey: false, endpointClass: 'remote' }, false, 1),
    ).toBe('bg-warning')
  })

  it('marks an unset slot as empty', () => {
    expect(slotDotColor(null, false, null)).toBe('bg-empty')
  })

  it('marks a connected non-local slot without privacy as warning', () => {
    expect(
      slotDotColor({ provider: 'openai', hasApiKey: true, endpointClass: 'remote' }, true, null),
    ).toBe('bg-warning')
  })

  it('marks a connected ready slot as success', () => {
    expect(
      slotDotColor({ provider: 'openai', hasApiKey: true, endpointClass: 'remote' }, true, 1),
    ).toBe('bg-success')
  })

  it('ranks warning above empty above success', () => {
    expect(worstSlotStatusColor(['bg-success', 'bg-empty'])).toBe('bg-empty')
    expect(worstSlotStatusColor(['bg-success', 'bg-warning', 'bg-empty'])).toBe('bg-warning')
    expect(worstSlotStatusColor(['bg-success', 'bg-success'])).toBe('bg-success')
  })
})

describe('resolveAiSetupAttention', () => {
  const unset = { config: null, connected: false }
  const openaiRemote = {
    provider: 'openai',
    hasApiKey: true,
    endpointClass: 'remote' as const,
  }
  const voyageRemote = {
    provider: 'voyage',
    hasApiKey: false,
    endpointClass: 'remote' as const,
  }

  it('returns only no_provider when nothing is chosen or connected (greenfield)', () => {
    expect(
      resolveAiSetupAttention({
        gen: unset,
        image: unset,
        embed: unset,
        privacyAcceptedAt: null,
      }),
    ).toEqual([{ kind: 'no_provider' }])
  })

  // New device that adopted a cloud vault: slots synced, keyring empty.
  // Must NOT claim this "no provider configured" — the provider is chosen.
  it('lists synced-but-keyless slots instead of no_provider', () => {
    expect(
      resolveAiSetupAttention({
        gen: {
          config: { provider: 'openai', hasApiKey: false, endpointClass: 'remote' },
          connected: false,
        },
        image: unset,
        embed: { config: voyageRemote, connected: false },
        privacyAcceptedAt: null,
      }),
    ).toEqual([{ kind: 'slots_not_connected', slots: ['chat', 'embed'] }, { kind: 'privacy' }])
  })

  it('returns privacy when a connected non-local slot has no consent', () => {
    expect(
      resolveAiSetupAttention({
        gen: { config: openaiRemote, connected: true },
        image: unset,
        embed: unset,
        privacyAcceptedAt: null,
      }),
    ).toEqual(expect.arrayContaining([{ kind: 'privacy' }, { kind: 'embed_not_configured' }]))
  })

  // Regression: new device + OpenAI connected for chat, embedding still a
  // synced-but-keyless slot (e.g. voyage) → yellow dots with no banner before
  // this helper existed.
  it('lists slots that are chosen but not connected on this device', () => {
    expect(
      resolveAiSetupAttention({
        gen: { config: openaiRemote, connected: true },
        image: unset,
        embed: { config: voyageRemote, connected: false },
        privacyAcceptedAt: 1,
      }),
    ).toEqual([{ kind: 'slots_not_connected', slots: ['embed'] }])
  })

  it('flags missing embedding when chat is ready and embed was never chosen', () => {
    expect(
      resolveAiSetupAttention({
        gen: { config: openaiRemote, connected: true },
        image: unset,
        embed: unset,
        privacyAcceptedAt: 1,
      }),
    ).toEqual([{ kind: 'embed_not_configured' }])
  })

  it('returns no issues when chat + embed are ready and privacy is accepted', () => {
    expect(
      resolveAiSetupAttention({
        gen: { config: openaiRemote, connected: true },
        image: unset,
        embed: {
          config: { provider: 'openai', hasApiKey: true, endpointClass: 'remote' },
          connected: true,
        },
        privacyAcceptedAt: 1,
      }),
    ).toEqual([])
  })

  it('does not flag privacy for a local-only connected setup', () => {
    expect(
      resolveAiSetupAttention({
        gen: {
          config: { provider: 'ollama', hasApiKey: false, endpointClass: 'local' },
          connected: true,
        },
        image: unset,
        embed: {
          config: { provider: 'ollama', hasApiKey: false, endpointClass: 'local' },
          connected: true,
        },
        privacyAcceptedAt: null,
      }),
    ).toEqual([])
  })

  it('treats an unread settings snapshot as unknown, not "not accepted"', () => {
    expect(
      resolveSetupPrivacyReceipt({
        hasSettings: false,
        settingsPrivacyAcceptedAt: null,
        storeHydrated: false,
        storePrivacyAcceptedAt: null,
      }),
    ).toEqual({ known: false, acceptedAt: null })
  })

  it('uses the store receipt when settings have not remounted yet', () => {
    expect(
      resolveSetupPrivacyReceipt({
        hasSettings: false,
        settingsPrivacyAcceptedAt: null,
        storeHydrated: true,
        storePrivacyAcceptedAt: 1_700_000_000,
      }),
    ).toEqual({ known: true, acceptedAt: 1_700_000_000 })
  })

  it('prefers the live settings receipt over the store', () => {
    expect(
      resolveSetupPrivacyReceipt({
        hasSettings: true,
        settingsPrivacyAcceptedAt: 9,
        storeHydrated: true,
        storePrivacyAcceptedAt: 1,
      }),
    ).toEqual({ known: true, acceptedAt: 9 })
  })

  it('does not derive banners until providers and privacy are both known', () => {
    expect(isAiSetupAttentionReady({ providersKnown: true, privacyKnown: false })).toBe(false)
    expect(isAiSetupAttentionReady({ providersKnown: false, privacyKnown: true })).toBe(false)
    expect(isAiSetupAttentionReady({ providersKnown: true, privacyKnown: true })).toBe(true)
  })

  it('never leaves a models-tab warning without an attention issue', () => {
    const cases = [
      {
        gen: { config: openaiRemote, connected: true },
        image: unset,
        embed: unset,
        privacyAcceptedAt: 1 as number | null,
      },
      {
        gen: { config: openaiRemote, connected: true },
        image: unset,
        embed: { config: voyageRemote, connected: false },
        privacyAcceptedAt: 1 as number | null,
      },
      {
        gen: {
          config: { provider: 'openai', hasApiKey: false, endpointClass: 'remote' as const },
          connected: false,
        },
        image: unset,
        embed: unset,
        privacyAcceptedAt: null as number | null,
      },
    ]
    for (const input of cases) {
      const models = modelsTabDotColor(input)
      if (models === 'bg-warning') {
        expect(resolveAiSetupAttention(input).length).toBeGreaterThan(0)
      }
    }
  })
})

describe('modelsTabDotColor / providersTabDotColor', () => {
  const openaiRemote = {
    provider: 'openai',
    hasApiKey: true,
    endpointClass: 'remote' as const,
  }

  it('promotes missing embedding to warning once chat is connected', () => {
    const models = modelsTabDotColor({
      gen: { config: openaiRemote, connected: true },
      image: { config: null, connected: false },
      embed: { config: null, connected: false },
      privacyAcceptedAt: 1,
    })
    expect(models).toBe('bg-warning')
    expect(providersTabDotColor(models, true)).toBe('bg-warning')
  })

  it('stays green when chat + embed are ready even if image is unset', () => {
    const models = modelsTabDotColor({
      gen: { config: openaiRemote, connected: true },
      image: { config: null, connected: false },
      embed: {
        config: { provider: 'openai', hasApiKey: true, endpointClass: 'remote' },
        connected: true,
      },
      privacyAcceptedAt: 1,
    })
    expect(models).toBe('bg-success')
    expect(providersTabDotColor(models, true)).toBe('bg-success')
  })

  it('is empty (not warning) when nothing is configured yet', () => {
    expect(
      modelsTabDotColor({
        gen: { config: null, connected: false },
        image: { config: null, connected: false },
        embed: { config: null, connected: false },
        privacyAcceptedAt: null,
      }),
    ).toBe('bg-empty')
  })
})

describe('buildConnectedProviderOptions', () => {
  const emptyReady = { embed: false, llm: false }

  it('returns an empty list when nothing is connected', () => {
    expect(buildConnectedProviderOptions('chat', new Map(), [], emptyReady)).toEqual([])
  })

  it('includes a hosted preset once its credential has hasApiKey: true', () => {
    const credentialByPreset = new Map<string, ProviderCredential>([
      [
        'openai',
        {
          presetId: 'openai',
          endpoint: 'https://api.openai.com/v1',
          hasApiKey: true,
          endpointClass: 'remote',
        },
      ],
    ])
    const options = buildConnectedProviderOptions('chat', credentialByPreset, [], emptyReady)
    expect(options).toEqual([{ value: 'openai', label: getPreset('openai')!.label }])
  })

  it('includes explicitly-added CLI presets even without credentials', () => {
    const options = buildConnectedProviderOptions('chat', new Map(), ['claude-cli'], emptyReady)
    expect(options).toEqual([{ value: 'claude-cli', label: getPreset('claude-cli')!.label }])
  })

  it('capability-filters: embed options never include CLI presets', () => {
    const options = buildConnectedProviderOptions(
      'embed',
      new Map(),
      ['claude-cli', 'voyage'],
      emptyReady,
    )
    const values = options.map((o) => o.value)
    expect(values).not.toContain('claude-cli')
    expect(values).toContain('voyage')
  })

  it('includes on-device-llm only when a chat model is downloaded', () => {
    expect(
      buildConnectedProviderOptions('chat', new Map(), [], emptyReady).map((o) => o.value),
    ).not.toContain('on-device-llm')
    expect(
      buildConnectedProviderOptions('chat', new Map(), [], {
        embed: false,
        llm: true,
      }).map((o) => o.value),
    ).toContain('on-device-llm')
  })

  it('excludes an on-device preset in addedProviders with no model downloaded', () => {
    // The exact false-connected state the ToU-dismissed Connect click used
    // to persist: a stale added-list entry must not surface the preset in
    // the feature-tab dropdown while its catalog is empty.
    expect(
      buildConnectedProviderOptions('chat', new Map(), ['on-device-llm'], emptyReady).map(
        (o) => o.value,
      ),
    ).not.toContain('on-device-llm')
  })

  it('appends the current value when it is not currently connected (stale slot)', () => {
    const options = buildConnectedProviderOptions('chat', new Map(), [], emptyReady, 'openai')
    expect(options).toEqual([{ value: 'openai', label: getPreset('openai')!.label }])
  })

  it('returns a flat list with no group structure', () => {
    const credentialByPreset = new Map<string, ProviderCredential>([
      [
        'openai',
        {
          presetId: 'openai',
          endpoint: 'https://api.openai.com/v1',
          hasApiKey: true,
          endpointClass: 'remote',
        },
      ],
    ])
    const options = buildConnectedProviderOptions(
      'chat',
      credentialByPreset,
      ['claude-cli'],
      emptyReady,
    )
    // Flat SelectOption[] — no key/label group wrappers.
    expect(options.every((o) => 'value' in o && 'label' in o && !('options' in o))).toBe(true)
  })
})

describe('providerIsConfigured', () => {
  // The trap this whole helper exists to avoid: `get_ai_provider_credentials`
  // returns a row for every preset with `endpoint` pre-filled from the
  // catalog default — so a never-touched `ollama` row already reads
  // `http://127.0.0.1:11434/v1`, NOT ''. Comparing against `!= ''` would
  // wrongly mark it configured; comparing against the catalog's own default
  // is the only correct test.
  it('a fresh ollama row at its default endpoint, no key, is NOT configured', () => {
    const ollamaDefault = getPreset('ollama')!.endpoint
    expect(
      providerIsConfigured(
        'ollama',
        credential({ presetId: 'ollama', endpoint: ollamaDefault, endpointClass: 'local' }),
        false,
      ),
    ).toBe(false)
  })

  it('an ollama row with an overridden endpoint IS configured', () => {
    expect(
      providerIsConfigured(
        'ollama',
        credential({ presetId: 'ollama', endpoint: 'http://192.168.1.50:11434/v1' }),
        false,
      ),
    ).toBe(true)
  })

  it('is NOT configured when the credential row has not loaded yet (undefined)', () => {
    expect(providerIsConfigured('ollama', undefined, false)).toBe(false)
    expect(providerIsConfigured('openai', undefined, false)).toBe(false)
  })

  it('a fresh other-local row at its non-empty default endpoint is NOT configured', () => {
    const otherLocalDefault = getPreset('other-local')!.endpoint
    expect(otherLocalDefault).not.toBe('')
    expect(
      providerIsConfigured(
        'other-local',
        credential({ presetId: 'other-local', endpoint: otherLocalDefault }),
        false,
      ),
    ).toBe(false)
  })

  it('a hosted preset (openai) with no key and the default endpoint is NOT configured', () => {
    const openaiDefault = getPreset('openai')!.endpoint
    expect(
      providerIsConfigured(
        'openai',
        credential({ presetId: 'openai', endpoint: openaiDefault, hasApiKey: false }),
        false,
      ),
    ).toBe(false)
  })

  it('a hosted preset (openai) with a stored API key IS configured, even at the default endpoint', () => {
    const openaiDefault = getPreset('openai')!.endpoint
    expect(
      providerIsConfigured(
        'openai',
        credential({ presetId: 'openai', endpoint: openaiDefault, hasApiKey: true }),
        false,
      ),
    ).toBe(true)
  })

  it('custom: default empty endpoint + no key is NOT configured', () => {
    expect(
      providerIsConfigured('custom', credential({ presetId: 'custom', endpoint: '' }), false),
    ).toBe(false)
  })

  it('custom: any non-empty endpoint IS configured (its default is empty, so any value is an override)', () => {
    expect(
      providerIsConfigured(
        'custom',
        credential({ presetId: 'custom', endpoint: 'http://127.0.0.1:9000/v1' }),
        false,
      ),
    ).toBe(true)
  })

  it('custom: a stored API key alone IS configured', () => {
    expect(
      providerIsConfigured(
        'custom',
        credential({ presetId: 'custom', endpoint: '', hasApiKey: true }),
        false,
      ),
    ).toBe(true)
  })

  it('cli presets (claude-cli / codex-cli) are ALWAYS unconfigured — added-list only', () => {
    expect(providerIsConfigured('claude-cli', undefined, true)).toBe(false)
    expect(
      providerIsConfigured(
        'codex-cli',
        credential({ presetId: 'codex-cli', endpoint: '', hasApiKey: true }),
        true,
      ),
    ).toBe(false)
  })

  it('integrated presets (on-device / on-device-llm) follow hasDownloadedIntegratedModel, ignoring credential state', () => {
    expect(providerIsConfigured('on-device', undefined, false)).toBe(false)
    expect(providerIsConfigured('on-device', undefined, true)).toBe(true)
    expect(providerIsConfigured('on-device-llm', undefined, false)).toBe(false)
    expect(providerIsConfigured('on-device-llm', undefined, true)).toBe(true)
  })

  it('is not configured for an unknown preset id', () => {
    expect(providerIsConfigured('not-a-real-preset', undefined, true)).toBe(false)
  })
})
