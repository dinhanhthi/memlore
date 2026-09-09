import { useEffect, useRef } from 'react'
import { getAiSettings } from '../lib/tauri'

/**
 * App-shell hook (Phase 6 v2 R3) — runs on mount and emits a single
 * **redacted** debug log line so post-mortems show whether AI was
 * configured at the time of a crash. No state, no side effects beyond
 * the log.
 *
 * **What this hook does NOT do anymore:**
 * - Run the v2 migration. That fires at unlock time inside
 *   `commands::crypto::initialize_encryption` so it sees the real
 *   SQLCipher-backed connection rather than the locked `:memory:`
 *   placeholder. Doing it from React mount was a critical bug — the
 *   migration would set its idempotence flag in the placeholder,
 *   which gets discarded on unlock, and the real DB never got cleaned.
 * - Hydrate the provider registry. Same reasoning — that's done on
 *   the backend by `crypto::initialize_encryption`.
 *
 * The log is emitted at `debug` level (not `info`) so users exporting
 * support logs don't ship their corporate AI-gateway hostname unless
 * they explicitly ask for verbose output. The host is summarised as
 * `local` / `remote` rather than the literal hostname; only the
 * provider id and class are spelled out.
 */
export function useAIProviderLifecycle(): void {
  const ranRef = useRef(false)

  useEffect(() => {
    if (ranRef.current) return
    ranRef.current = true

    void (async () => {
      try {
        const s = await getAiSettings()
        if (s.provider) {
          // Redact the literal hostname — `class` is enough fingerprint
          // for support purposes ("provider configured, traffic stays
          // local" vs "provider configured, traffic egresses").
          const cls = s.endpointClass
          const privacyAcceptedForClass =
            cls === 'local' || (cls != null && s.privacyAcceptedAt != null)
          console.debug(
            `[ai] provider=${s.provider} class=${cls ?? 'unknown'} hasApiKey=${s.hasApiKey} privacyAccepted=${privacyAcceptedForClass}`,
          )
        } else {
          console.debug('[ai] no provider configured')
        }
      } catch {
        // Don't surface — the panel will retry on its own mount.
      }
    })()
  }, [])
}
