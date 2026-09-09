import { getPreset, type AIProvidersConfig } from '../types/ai'
import type { AiModelSlotId, AiSetupAttentionIssue } from './aiProviderStatus'

export type AdoptSetupStage = 'provider' | 'image' | 'embedding'

/** Device-local settings row. Must stay off `SYNCABLE_SETTING_KEYS`. */
export const ADOPT_SETUP_DISMISS_KEY = 'ai_adopt_setup_dismissed_fingerprint'

function slotFingerprint(provider: string | undefined, model: string | undefined): string {
  if (!provider) return '-'
  return `${provider}:${model ?? ''}`
}

/** Stable identity of the synced AI slot choices on this vault.
 *  Used as the device-local dismiss key so a later cloud provider/model
 *  change can re-prompt without nagging for the same setup. */
export function adoptedAiSetupFingerprint(providers: AIProvidersConfig): string {
  const chat = slotFingerprint(providers.generation?.provider, providers.generation?.chatModel)
  const image = slotFingerprint(providers.image?.provider, providers.image?.imageModel)
  const embed = slotFingerprint(providers.embedding?.provider, providers.embedding?.embeddingModel)
  return `chat:${chat}|image:${image}|embed:${embed}`
}

export function shouldPromptAdoptedAiSetup(input: {
  issues: readonly AiSetupAttentionIssue[]
  anyConnected: boolean
  dismissedFingerprint: string | null
  currentFingerprint: string
  credentialsLoaded: boolean
}): boolean {
  if (!input.credentialsLoaded) return false
  if (input.anyConnected) return false
  if (!input.issues.some((issue) => issue.kind === 'slots_not_connected')) return false
  return input.dismissedFingerprint !== input.currentFingerprint
}

/** Wizard stages for the adopt flow, always chat → image → embed. */
export function adoptSetupStages(slots: readonly AiModelSlotId[]): AdoptSetupStage[] {
  const stages: AdoptSetupStage[] = []
  if (slots.includes('chat')) stages.push('provider')
  if (slots.includes('image')) stages.push('image')
  if (slots.includes('embed')) stages.push('embedding')
  return stages
}

/** Freeze the adopt walk: every still-needed slot, every already-chosen
 *  cloud slot, and always embedding (so saving a chat key cannot skip
 *  the embed/model-download step). */
export function snapshotAdoptSlots(
  notConnected: readonly AiModelSlotId[],
  providers: AIProvidersConfig,
): AiModelSlotId[] {
  const slots = new Set<AiModelSlotId>(notConnected)
  if (providers.generation) slots.add('chat')
  if (providers.image) slots.add('image')
  if (providers.embedding) slots.add('embed')
  slots.add('embed')
  const order: AiModelSlotId[] = ['chat', 'image', 'embed']
  return order.filter((id) => slots.has(id))
}

/** Endpoint is only user-facing for the two open-ended presets. Hosted
 *  and fixed local URLs must not render the field. */
export function providerEndpointIsEditable(presetId: string): boolean {
  return presetId === 'custom' || presetId === 'other-local'
}

/** Prefill one slot from synced provider+model without resetting the model
 *  to the catalog default (which `handleSelect*` does). */
export function seedAdoptSlotDraft(
  presetId: string | null | undefined,
  model: string | null | undefined,
  resolveEndpoint: (presetId: string, catalogDefault: string) => string,
): { presetId: string; model: string; endpoint: string } | null {
  if (!presetId) return null
  const preset = getPreset(presetId)
  if (!preset) return null
  return {
    presetId,
    model: model ?? '',
    endpoint: resolveEndpoint(presetId, preset.endpoint),
  }
}
