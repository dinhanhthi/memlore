import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useEffect } from 'react'
import type { Entry } from '../types/entry'
import { emitEntriesChanged, emitEntryPatched } from './useEntries'

export type McpEntryChangedKind = 'created' | 'appended' | 'metadata'

export interface McpEntryChangedPayload {
  kind: McpEntryChangedKind
  entryId: string
  journalId: string
  yjsUpdate?: number[]
  patch?: Partial<Entry>
}

const MCP_ENTRY_CHANGED_EVENT = 'mcp:entry-changed'
const ENTRY_DOC_UPDATE_EVENT = 'memlore:entry-doc-update'

function handleMcpEntryChanged(payload: McpEntryChangedPayload) {
  switch (payload.kind) {
    case 'created':
      emitEntriesChanged()
      return
    case 'appended':
      if (payload.yjsUpdate) {
        window.dispatchEvent(
          new CustomEvent(ENTRY_DOC_UPDATE_EVENT, {
            detail: { entryId: payload.entryId, update: payload.yjsUpdate },
          }),
        )
      }
      if (payload.patch) {
        emitEntryPatched(payload.entryId, payload.patch)
      }
      return
    case 'metadata':
      if (payload.patch) {
        emitEntryPatched(payload.entryId, payload.patch)
      }
      return
  }
}

/**
 * Bridges the backend `mcp:entry-changed` hop onto the existing window bus.
 * Mount once at the app root — do not invent a second refresh path.
 */
export function useMcpEntryEvents() {
  useEffect(() => {
    let cancelled = false
    const unlisteners: UnlistenFn[] = []

    async function subscribe() {
      try {
        const unlisten = await listen<McpEntryChangedPayload>(MCP_ENTRY_CHANGED_EVENT, (event) => {
          handleMcpEntryChanged(event.payload)
        })

        if (cancelled) {
          unlisten()
          return
        }
        unlisteners.push(unlisten)
      } catch {
        // Event bridge unavailable (tests without a Tauri runtime, or web).
      }
    }

    void subscribe()

    return () => {
      cancelled = true
      for (const unlisten of unlisteners) unlisten()
    }
  }, [])
}
