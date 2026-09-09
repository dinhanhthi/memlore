import { describe, expect, it } from 'vitest'
import type { AIProvidersConfig } from '../types/ai'
import type { AiSetupAttentionIssue } from './aiProviderStatus'
import {
  adoptedAiSetupFingerprint,
  adoptSetupStages,
  providerEndpointIsEditable,
  seedAdoptSlotDraft,
  shouldPromptAdoptedAiSetup,
  snapshotAdoptSlots,
} from './adoptedAiSetup'

const unset: AIProvidersConfig = {
  generation: null,
  image: null,
  embedding: null,
}

const openaiGen = {
  provider: 'openai',
  endpoint: 'https://api.openai.com/v1',
  endpointClass: 'remote' as const,
  chatModel: 'gpt-5-mini',
  hasApiKey: false,
}

const voyageEmbed = {
  provider: 'voyage',
  endpoint: 'https://api.voyageai.com/v1',
  endpointClass: 'remote' as const,
  embeddingModel: 'voyage-3',
  hasApiKey: false,
}

const dalleImage = {
  provider: 'openai',
  endpoint: 'https://api.openai.com/v1',
  endpointClass: 'remote' as const,
  imageModel: 'gpt-image-1',
  hasApiKey: false,
}

describe('adoptedAiSetupFingerprint', () => {
  it('uses "-" for every unset slot', () => {
    expect(adoptedAiSetupFingerprint(unset)).toBe('chat:-|image:-|embed:-')
  })

  it('encodes provider and model for each chosen slot', () => {
    expect(
      adoptedAiSetupFingerprint({
        generation: openaiGen,
        image: dalleImage,
        embedding: voyageEmbed,
      }),
    ).toBe('chat:openai:gpt-5-mini|image:openai:gpt-image-1|embed:voyage:voyage-3')
  })

  it('keeps unset slots as "-" when only chat is chosen', () => {
    expect(
      adoptedAiSetupFingerprint({
        generation: openaiGen,
        image: null,
        embedding: null,
      }),
    ).toBe('chat:openai:gpt-5-mini|image:-|embed:-')
  })
})

describe('shouldPromptAdoptedAiSetup', () => {
  const adoptedIssues: AiSetupAttentionIssue[] = [
    { kind: 'slots_not_connected', slots: ['chat', 'embed'] },
  ]
  const fingerprint = 'chat:openai:gpt-5-mini|image:-|embed:voyage:voyage-3'

  it('is false until credentials have loaded', () => {
    expect(
      shouldPromptAdoptedAiSetup({
        issues: adoptedIssues,
        anyConnected: false,
        dismissedFingerprint: null,
        currentFingerprint: fingerprint,
        credentialsLoaded: false,
      }),
    ).toBe(false)
  })

  it('is false when any slot is already connected here', () => {
    expect(
      shouldPromptAdoptedAiSetup({
        issues: adoptedIssues,
        anyConnected: true,
        dismissedFingerprint: null,
        currentFingerprint: fingerprint,
        credentialsLoaded: true,
      }),
    ).toBe(false)
  })

  it('is true for synced-but-keyless slots that have not been dismissed', () => {
    expect(
      shouldPromptAdoptedAiSetup({
        issues: adoptedIssues,
        anyConnected: false,
        dismissedFingerprint: null,
        currentFingerprint: fingerprint,
        credentialsLoaded: true,
      }),
    ).toBe(true)
  })

  it('is false when the same fingerprint was dismissed', () => {
    expect(
      shouldPromptAdoptedAiSetup({
        issues: adoptedIssues,
        anyConnected: false,
        dismissedFingerprint: fingerprint,
        currentFingerprint: fingerprint,
        credentialsLoaded: true,
      }),
    ).toBe(false)
  })

  it('is true again when the cloud fingerprint changed after dismiss', () => {
    expect(
      shouldPromptAdoptedAiSetup({
        issues: adoptedIssues,
        anyConnected: false,
        dismissedFingerprint: fingerprint,
        currentFingerprint: 'chat:anthropic:claude-sonnet-4|image:-|embed:voyage:voyage-3',
        credentialsLoaded: true,
      }),
    ).toBe(true)
  })

  it('is false for a greenfield no_provider vault', () => {
    expect(
      shouldPromptAdoptedAiSetup({
        issues: [{ kind: 'no_provider' }],
        anyConnected: false,
        dismissedFingerprint: null,
        currentFingerprint: 'chat:-|image:-|embed:-',
        credentialsLoaded: true,
      }),
    ).toBe(false)
  })

  it('is false when the only issue is privacy', () => {
    expect(
      shouldPromptAdoptedAiSetup({
        issues: [{ kind: 'privacy' }],
        anyConnected: false,
        dismissedFingerprint: null,
        currentFingerprint: fingerprint,
        credentialsLoaded: true,
      }),
    ).toBe(false)
  })

  it('is false when the only issue is embed_not_configured', () => {
    expect(
      shouldPromptAdoptedAiSetup({
        issues: [{ kind: 'embed_not_configured' }],
        anyConnected: false,
        dismissedFingerprint: null,
        currentFingerprint: fingerprint,
        credentialsLoaded: true,
      }),
    ).toBe(false)
  })
})

describe('adoptSetupStages', () => {
  it('maps connectedness slots onto wizard stages in chat → image → embed order', () => {
    expect(adoptSetupStages(['embed', 'image', 'chat'])).toEqual(['provider', 'image', 'embedding'])
  })

  it('omits stages for slots that do not need setup', () => {
    expect(adoptSetupStages(['embed'])).toEqual(['embedding'])
    expect(adoptSetupStages([])).toEqual([])
  })
})

describe('snapshotAdoptSlots', () => {
  it('keeps every chosen cloud slot and always includes embed', () => {
    expect(
      snapshotAdoptSlots(['chat'], {
        generation: openaiGen,
        image: null,
        embedding: null,
      }),
    ).toEqual(['chat', 'embed'])
  })

  it('does not drop embed when it was already in the not-connected list', () => {
    expect(
      snapshotAdoptSlots(['chat', 'embed'], {
        generation: openaiGen,
        image: null,
        embedding: voyageEmbed,
      }),
    ).toEqual(['chat', 'embed'])
  })

  it('includes a synced image slot', () => {
    expect(
      snapshotAdoptSlots(['chat'], {
        generation: openaiGen,
        image: dalleImage,
        embedding: voyageEmbed,
      }),
    ).toEqual(['chat', 'image', 'embed'])
  })
})

describe('providerEndpointIsEditable', () => {
  it('is true only for open-ended presets', () => {
    expect(providerEndpointIsEditable('openai')).toBe(false)
    expect(providerEndpointIsEditable('ollama')).toBe(false)
    expect(providerEndpointIsEditable('custom')).toBe(true)
    expect(providerEndpointIsEditable('other-local')).toBe(true)
  })
})

describe('seedAdoptSlotDraft', () => {
  it('returns null when no preset is chosen', () => {
    expect(seedAdoptSlotDraft(undefined, 'gpt-5-mini', () => 'x')).toBeNull()
  })

  it('returns null for an unknown preset id', () => {
    expect(seedAdoptSlotDraft('not-a-preset', 'm', () => 'x')).toBeNull()
  })

  it('keeps the synced model and resolves the endpoint without catalog defaults for the model', () => {
    const draft = seedAdoptSlotDraft('openai', 'gpt-5-mini', (id, fallback) => {
      expect(id).toBe('openai')
      expect(fallback).toBeTruthy()
      return 'https://api.openai.com/v1'
    })
    expect(draft).toEqual({
      presetId: 'openai',
      model: 'gpt-5-mini',
      endpoint: 'https://api.openai.com/v1',
    })
  })
})
