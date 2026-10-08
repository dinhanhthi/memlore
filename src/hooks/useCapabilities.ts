import { useMemo } from 'react'
import { capabilities, isWeb, type Capabilities } from '../lib/platform'
import { useCapabilitiesStore } from '../stores/capabilitiesStore'

/**
 * Static platform capabilities; on web the runtime flags apply: `writes`, plus the ones the
 * synced desktops enable (a desktop importing outbox v2 intents, a desktop month index).
 * `taxonomyEdits` (journal/tag rename and delete) stays false on web.
 */
export function useCapabilities(): Capabilities {
  const writes = useCapabilitiesStore((s) => s.writes)
  const outboxV2 = useCapabilitiesStore((s) => s.outboxV2)
  const monthIndex = useCapabilitiesStore((s) => s.monthIndex)
  return useMemo(() => {
    if (!isWeb) return capabilities
    const intents = writes && outboxV2
    return {
      ...capabilities,
      writes,
      taxonomyCreate: intents,
      deleteEntries: intents,
      gallery: monthIndex,
      lookback: monthIndex,
      stats: monthIndex,
      mapView: monthIndex,
      versionsRead: monthIndex,
    }
  }, [writes, outboxV2, monthIndex])
}
