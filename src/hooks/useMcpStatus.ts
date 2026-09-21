import { useCallback, useEffect, useState } from 'react'
import { errMsg } from '../lib/errMsg'
import { getMcpStatus, type McpStatus } from '../lib/tauri'

export interface UseMcpStatus {
  status: McpStatus | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

/**
 * Snapshot of the local MCP Unix-socket server.
 * Loads on mount; call `refresh` after the Settings toggle so running/stopped
 * updates without inventing a second IPC wrapper.
 */
export function useMcpStatus(): UseMcpStatus {
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const apply = useCallback((next: McpStatus | null, nextError: string | null) => {
    setStatus(next)
    setError(nextError)
    setLoading(false)
  }, [])

  const refresh = useCallback(async () => {
    try {
      apply(await getMcpStatus(), null)
    } catch (e) {
      setError(errMsg(e))
      setLoading(false)
    }
  }, [apply])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const next = await getMcpStatus()
        if (!cancelled) apply(next, null)
      } catch (e) {
        if (!cancelled) apply(null, errMsg(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [apply])

  return { status, loading, error, refresh }
}
