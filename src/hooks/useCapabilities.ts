import { useMemo } from 'react'
import { capabilities, isWeb, type Capabilities } from '../lib/platform'
import { useCapabilitiesStore } from '../stores/capabilitiesStore'

/** Static platform capabilities with the runtime `writes` flag applied on web. */
export function useCapabilities(): Capabilities {
  const writes = useCapabilitiesStore((s) => s.writes)
  return useMemo(() => (isWeb ? { ...capabilities, writes } : capabilities), [writes])
}
