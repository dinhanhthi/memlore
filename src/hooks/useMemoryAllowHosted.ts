import { setMemoryAllowHosted as setMemoryAllowHostedCommand } from '../lib/tauri'
import { usePersistedSetting } from './usePersistedSetting'

const SETTING_KEY = 'ai_memory_allow_hosted'

function parseBool(raw: string | null | undefined): boolean {
  return raw === 'true'
}

/**
 * Reads + writes `ai_memory_allow_hosted` — off by default. When on, the
 * user has explicitly acknowledged that a hosted (`Remote`) or CLI/
 * subscription provider may power a memory slot, meaning raw journal
 * entries and full Daily Chat transcripts leave the machine for extraction
 * and persona style sampling (broader than the short distilled facts Daily
 * Chat already sends). Backend enforcement lives in
 * `enforce_memory_slot_class` (write time) and `load_memory_gen_slot` /
 * `load_memory_embed_slot` (registry-hydration time).
 *
 * The write goes through the single atomic `set_memory_allow_hosted`
 * command, which persists the flag AND reconciles the in-memory registry
 * (rejects a now-disallowed slot on turn-off, re-hydrates both slots on
 * turn-on) in one backend call — so the DB and the registry can never
 * disagree the way they could when this was a `setSetting` call followed by
 * a separate `rejectDisallowedMemorySlots` call. `memoryEnabled` is the
 * reconciled `is_memory_enabled()` reading straight off that same call, for
 * callers that need to know the feature's live state without re-fetching.
 */
export function useMemoryAllowHosted(): {
  allowHosted: boolean
  loading: boolean
  setAllowHosted: (next: boolean) => Promise<{ memoryEnabled: boolean }>
} {
  const {
    value: allowHosted,
    loading,
    setValue: setAllowHosted,
  } = usePersistedSetting({
    key: SETTING_KEY,
    defaultValue: false,
    parse: parseBool,
    persist: async (next) => {
      const result = await setMemoryAllowHostedCommand(next)
      return { memoryEnabled: result.memoryEnabled }
    },
  })

  return { allowHosted, loading, setAllowHosted }
}
