import { useMemo } from 'react'
import { capabilities, isWeb, type Capabilities } from '../lib/platform'
import { useCapabilitiesStore } from '../stores/capabilitiesStore'

/**
 * Static platform capabilities; on web the runtime flags apply: `writes`, plus the ones the
 * synced desktops enable (a desktop importing outbox v2 intents, a desktop month index).
 * `taxonomyEdits` (journal/tag rename and delete) stays false on web.
 */
function deriveCapabilities(writes: boolean, outboxV2: boolean, monthIndex: boolean): Capabilities {
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
    // Home's cards read the same index views as Stats / Gallery / On this day.
    dashboard: monthIndex,
    mapView: monthIndex,
    versionsRead: monthIndex,
  }
}

/** The current capabilities outside React (command palette `available` checks). */
export function currentCapabilities(): Capabilities {
  const { writes, outboxV2, monthIndex } = useCapabilitiesStore.getState()
  return deriveCapabilities(writes, outboxV2, monthIndex)
}

export function useCapabilities(): Capabilities {
  const writes = useCapabilitiesStore((s) => s.writes)
  const outboxV2 = useCapabilitiesStore((s) => s.outboxV2)
  const monthIndex = useCapabilitiesStore((s) => s.monthIndex)
  return useMemo(
    () => deriveCapabilities(writes, outboxV2, monthIndex),
    [writes, outboxV2, monthIndex],
  )
}
