import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Entry } from '../types/entry'
import type { McpEntryChangedPayload } from './useMcpEntryEvents'

type Handler = (event: { payload: McpEntryChangedPayload }) => void

const handlers: Record<string, Handler> = {}
const { listen, unlisten } = vi.hoisted(() => ({
  listen: vi.fn(),
  unlisten: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: (name: string, handler: Handler) => listen(name, handler),
}))

import { useMcpEntryEvents } from './useMcpEntryEvents'

const fireChanged = (payload: McpEntryChangedPayload) => {
  handlers['mcp:entry-changed']?.({ payload })
}

function collectWindowEvents() {
  const entriesChanged: Event[] = []
  const patched: CustomEvent<{ id: string; patch: Partial<Entry> }>[] = []
  const docUpdates: CustomEvent<{ entryId: string; update: number[] }>[] = []

  const onEntriesChanged = (event: Event) => {
    entriesChanged.push(event)
  }
  const onPatched = (event: Event) => {
    patched.push(event as CustomEvent<{ id: string; patch: Partial<Entry> }>)
  }
  const onDocUpdate = (event: Event) => {
    docUpdates.push(event as CustomEvent<{ entryId: string; update: number[] }>)
  }

  window.addEventListener('memlore:entries-changed', onEntriesChanged)
  window.addEventListener('memlore:entry-patched', onPatched)
  window.addEventListener('memlore:entry-doc-update', onDocUpdate)

  return {
    entriesChanged,
    patched,
    docUpdates,
    dispose() {
      window.removeEventListener('memlore:entries-changed', onEntriesChanged)
      window.removeEventListener('memlore:entry-patched', onPatched)
      window.removeEventListener('memlore:entry-doc-update', onDocUpdate)
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const name of Object.keys(handlers)) delete handlers[name]
  listen.mockImplementation(async (name: string, handler: Handler) => {
    handlers[name] = handler
    return unlisten
  })
})

describe('useMcpEntryEvents', () => {
  it('created maps to emitEntriesChanged and never patches or applies a doc update', async () => {
    renderHook(() => useMcpEntryEvents())
    await waitFor(() => expect(handlers['mcp:entry-changed']).toBeDefined())
    const bus = collectWindowEvents()

    act(() => {
      fireChanged({ kind: 'created', entryId: 'entry-1', journalId: 'journal-1' })
    })

    expect(bus.entriesChanged).toHaveLength(1)
    expect(bus.patched).toHaveLength(0)
    expect(bus.docUpdates).toHaveLength(0)
    bus.dispose()
  })

  it('appended dispatches a doc-update and patches preview_text plus updated_at', async () => {
    renderHook(() => useMcpEntryEvents())
    await waitFor(() => expect(handlers['mcp:entry-changed']).toBeDefined())
    const bus = collectWindowEvents()

    act(() => {
      fireChanged({
        kind: 'appended',
        entryId: 'entry-2',
        journalId: 'journal-1',
        yjsUpdate: [1, 2, 3],
        patch: { preview_text: 'hello world', updated_at: 1_700_000_042 },
      })
    })

    expect(bus.entriesChanged).toHaveLength(0)
    expect(bus.docUpdates).toHaveLength(1)
    expect(bus.docUpdates[0].detail).toEqual({
      entryId: 'entry-2',
      update: [1, 2, 3],
    })
    expect(bus.patched).toHaveLength(1)
    expect(bus.patched[0].detail).toEqual({
      id: 'entry-2',
      patch: { preview_text: 'hello world', updated_at: 1_700_000_042 },
    })
    bus.dispose()
  })

  it('metadata patches the entry and never dispatches a doc-update', async () => {
    renderHook(() => useMcpEntryEvents())
    await waitFor(() => expect(handlers['mcp:entry-changed']).toBeDefined())
    const bus = collectWindowEvents()

    act(() => {
      fireChanged({
        kind: 'metadata',
        entryId: 'entry-3',
        journalId: 'journal-9',
        yjsUpdate: [9, 9],
        patch: { title: 'Renamed', emotion: 'good', updated_at: 1_700_000_099 },
      })
    })

    expect(bus.entriesChanged).toHaveLength(0)
    expect(bus.docUpdates).toHaveLength(0)
    expect(bus.patched).toHaveLength(1)
    expect(bus.patched[0].detail).toEqual({
      id: 'entry-3',
      patch: { title: 'Renamed', emotion: 'good', updated_at: 1_700_000_099 },
    })
    bus.dispose()
  })

  it('unsubscribes from mcp:entry-changed on unmount', async () => {
    const { unmount } = renderHook(() => useMcpEntryEvents())
    await waitFor(() => expect(handlers['mcp:entry-changed']).toBeDefined())

    unmount()

    expect(unlisten).toHaveBeenCalledTimes(1)
  })
})
