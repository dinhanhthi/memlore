import { useAiStoreFlag } from './useAiFeatureEnabled'

/**
 * Read-only probe for "Use persona" (`user_persona.enabled`).
 *
 * Same contract as the `useAi<Feature>Enabled` family:
 *
 * - `null` while the first hydration is in flight, so persona-gated UI can
 *   render its idle state instead of flashing a disabled control in.
 * - `true` when persona is on, `false` otherwise.
 *
 * Persona is independent of User Memory — it can be on while the memory
 * master toggle is off, and the persona row is seeded enabled, so this reads
 * `true` for users who never touched the setting.
 */
export function useAiPersonaEnabled(): boolean | null {
  return useAiStoreFlag((s) => s.personaEnabled)
}
