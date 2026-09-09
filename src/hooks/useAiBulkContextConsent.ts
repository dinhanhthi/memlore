import { useCallback, useEffect, useState } from 'react'
import { acceptAiBulkContext, getAiProviders, getAiSettings } from '../lib/tauri'
import type { AIFullSettings, EndpointClass } from '../types/ai'

export interface BulkContextConsentInfo {
  endpointClass: EndpointClass
  providerLabel: string
  entryCount: number
  start: number
  end: number
}

export interface UseAiBulkContextConsentReturn {
  settings: AIFullSettings | null
  loading: boolean
  /** True when the generation slot is remote/subscription and bulk consent
   *  has not been stamped for that class. Local endpoints are always exempt. */
  needsBulkConsent: (endpointClass: EndpointClass) => boolean
  acceptBulkContext: (cls: EndpointClass) => Promise<number>
  /** Provider display label for the generation slot (for modal copy). */
  providerLabel: string | null
  /** Generation-slot endpoint class from getAiProviders, or null if unset/error. */
  generationEndpointClass: EndpointClass | null
  refresh: () => Promise<void>
}

/**
 * Reads AI settings + generation-slot provider config to decide whether a
 * multi-entry run must show the bulk-context consent modal first.
 */
export function useAiBulkContextConsent(): UseAiBulkContextConsentReturn {
  const [settings, setSettings] = useState<AIFullSettings | null>(null)
  const [providerLabel, setProviderLabel] = useState<string | null>(null)
  const [generationEndpointClass, setGenerationEndpointClass] = useState<EndpointClass | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [s, providers] = await Promise.all([getAiSettings(), getAiProviders()])
      setSettings(s)
      setProviderLabel(providers.generation?.provider ?? null)
      setGenerationEndpointClass(providers.generation?.endpointClass ?? null)
    } catch {
      setSettings(null)
      setProviderLabel(null)
      setGenerationEndpointClass(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const needsBulkConsent = useCallback(
    (endpointClass: EndpointClass): boolean => {
      if (endpointClass === 'local') return false
      if (!settings) return true
      return settings.privacyAcceptedAt == null
    },
    [settings],
  )

  const acceptBulkContext = useCallback(async (_cls: EndpointClass): Promise<number> => {
    const ts = await acceptAiBulkContext()
    setSettings((prev) => (prev ? { ...prev, privacyAcceptedAt: ts } : prev))
    return ts
  }, [])

  return {
    settings,
    loading,
    needsBulkConsent,
    acceptBulkContext,
    providerLabel,
    generationEndpointClass,
    refresh,
  }
}
