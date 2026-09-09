import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('../lib/tauri', () => ({
  listAiAuditLog: vi.fn(),
  clearAiAuditLog: vi.fn(),
  getAiAuditRetentionDays: vi.fn(),
  setAiAuditRetentionDays: vi.fn(),
}))

import * as tauri from '../lib/tauri'
import { useAiAuditLog } from './useAiAuditLog'
import type { AiAuditLogRow } from '../types/ai'

/** Build a minimal valid AiAuditLogRow. Tests still pass an `id` numeric in
 *  overrides for terseness — we map it to (device_id="local", local_seq=id). */
function makeRow(overrides: Partial<AiAuditLogRow> & { id: number }): AiAuditLogRow {
  const { id, ...rest } = overrides
  return {
    device_id: 'local',
    local_seq: id,
    created_at: 1_000_000 + id,
    feature: 'smart_title',
    operation: 'chat',
    provider_id: 'openai',
    model_id: 'gpt-4o-mini',
    endpoint_host: 'api.openai.com',
    endpoint_class: 'remote',
    payload_bytes: 42,
    latency_ms: 150,
    status: 'ok',
    error_code: null,
    tokens_in: null,
    tokens_out: null,
    device_name: 'Test Device',
    ...rest,
  }
}

/** Generate an array of rows with sequential local_seqs. */
function makeRows(count: number, idOffset = 0): AiAuditLogRow[] {
  return Array.from({ length: count }, (_, i) => makeRow({ id: idOffset + i + 1 }))
}

beforeEach(() => {
  vi.mocked(tauri.listAiAuditLog).mockReset()
  vi.mocked(tauri.clearAiAuditLog).mockReset()
  vi.mocked(tauri.getAiAuditRetentionDays).mockReset()
  vi.mocked(tauri.setAiAuditRetentionDays).mockReset()
  // Default retention
  vi.mocked(tauri.getAiAuditRetentionDays).mockResolvedValue(90)
})

describe('useAiAuditLog', () => {
  // ── Test 1: pagination + dedup ────────────────────────────────────────────

  it('accumulates rows across pages and deduplicates by id', async () => {
    const firstPage = makeRows(25)
    const secondPage = makeRows(10, 25)

    vi.mocked(tauri.listAiAuditLog)
      .mockResolvedValueOnce(firstPage) // initial load
      .mockResolvedValueOnce(secondPage) // loadMore

    const { result } = renderHook(() => useAiAuditLog())

    // Wait for first page to land
    await waitFor(() => expect(result.current.rows.length).toBe(25))
    expect(result.current.hasMore).toBe(true)

    // Load next page
    act(() => {
      result.current.loadMore()
    })

    await waitFor(() => expect(result.current.rows.length).toBe(35))
    expect(result.current.hasMore).toBe(false) // second page < 25 rows

    // Verify no duplicates: all (device_id, local_seq) pairs should be unique
    const keys = result.current.rows.map((r) => `${r.device_id}-${r.local_seq}`)
    expect(new Set(keys).size).toBe(35)
  })

  it('dedup keys by (device_id, local_seq) — same local_seq on different devices is NOT a duplicate', async () => {
    // Regression guard: a naive `r.id`-style dedup would collapse rows
    // from two devices that happen to share a local_seq. Each device has
    // its own seq space, so both rows must survive.
    //
    // Make page 1 exactly PAGE_SIZE (25) rows so hasMore stays true and
    // loadMore actually fetches page 2.
    const firstPage: AiAuditLogRow[] = [
      // 24 "local" rows + 1 row from peer-a at local_seq=1 (collision-style).
      ...makeRows(24).map((r, i) => ({ ...r, local_seq: i + 1 })),
      { ...makeRow({ id: 1 }), device_id: 'peer-a' },
    ]
    const secondPage: AiAuditLogRow[] = [
      // local_seq=1 exact duplicate of page-1 local row (must dedup),
      // plus a fresh local row.
      { ...makeRow({ id: 1 }), device_id: 'local' },
      { ...makeRow({ id: 99 }), device_id: 'local' },
    ]

    vi.mocked(tauri.listAiAuditLog)
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage)

    const { result } = renderHook(() => useAiAuditLog())
    await waitFor(() => expect(result.current.rows.length).toBe(25))

    await act(async () => {
      result.current.loadMore()
    })

    // Expected after loadMore:
    //  - 24 local rows from page 1 (local_seq=1..24)
    //  - 1 peer-a row at local_seq=1 (different device — survives dedup)
    //  - 1 new local row at local_seq=99 (page 2)
    //  - the local-1 duplicate from page 2 is dropped
    // Total: 26 unique rows.
    await waitFor(() => expect(result.current.rows.length).toBe(26))
    const keys = result.current.rows.map((r) => `${r.device_id}-${r.local_seq}`)
    expect(new Set(keys).size).toBe(26)
    expect(keys).toContain('local-1')
    expect(keys).toContain('peer-a-1')
    expect(keys).toContain('local-99')
  })

  // ── Test 2: filter change resets pagination ───────────────────────────────

  it('resets pagination and refetches with offset=0 when filter.providers changes', async () => {
    const initialRows = makeRows(5)
    const filteredRows = makeRows(2, 100)

    vi.mocked(tauri.listAiAuditLog)
      .mockResolvedValueOnce(initialRows) // initial (no filter)
      .mockResolvedValueOnce(filteredRows) // after filter applied

    const { result } = renderHook(() => useAiAuditLog())

    // Wait for initial rows
    await waitFor(() => expect(result.current.rows.length).toBe(5))

    // Apply a provider filter
    act(() => {
      result.current.setFilter({ providers: ['openai'] })
    })

    // After filter change: should reset + refetch
    await waitFor(() => expect(result.current.rows.length).toBe(2))

    // Verify the second call was made with offset=0 and the filter
    const calls = vi.mocked(tauri.listAiAuditLog).mock.calls
    expect(calls.length).toBe(2)
    expect(calls[1][0]).toMatchObject({ providers: ['openai'] })
    expect(calls[1][2]).toBe(0) // offset=0
  })

  // ── Test 3: clearAll invokes the right command and resets state ───────────

  it('clearAll invokes clear_ai_audit_log and resets local rows', async () => {
    const initialRows = makeRows(5)
    // first load, then the post-clear reload (will return empty)
    vi.mocked(tauri.listAiAuditLog).mockResolvedValueOnce(initialRows).mockResolvedValueOnce([])
    vi.mocked(tauri.clearAiAuditLog).mockResolvedValueOnce(5)

    const { result } = renderHook(() => useAiAuditLog())
    await waitFor(() => expect(result.current.rows.length).toBe(5))

    await act(async () => {
      await result.current.clearAll()
    })

    expect(vi.mocked(tauri.clearAiAuditLog)).toHaveBeenCalledOnce()

    // After clearAll rows should be empty
    await waitFor(() => expect(result.current.rows.length).toBe(0))
  })

  it('uses the backend-normalized retention without writing again on mount', async () => {
    vi.mocked(tauri.listAiAuditLog).mockResolvedValue([])
    vi.mocked(tauri.getAiAuditRetentionDays).mockResolvedValueOnce(30)

    const { result } = renderHook(() => useAiAuditLog())

    await waitFor(() => expect(result.current.isRetentionLoading).toBe(false))
    expect(result.current.retention).toBe(30)
    expect(tauri.setAiAuditRetentionDays).not.toHaveBeenCalled()
    expect(result.current.isRetentionLoading).toBe(false)
  })

  it('preserves the selected retention when the readback fails', async () => {
    vi.mocked(tauri.listAiAuditLog).mockResolvedValue([])
    vi.mocked(tauri.setAiAuditRetentionDays).mockResolvedValue()
    vi.mocked(tauri.getAiAuditRetentionDays)
      .mockResolvedValueOnce(90)
      .mockRejectedValueOnce(new Error('readback failed'))

    const { result } = renderHook(() => useAiAuditLog())
    await waitFor(() => expect(result.current.retention).toBe(90))

    await act(async () => {
      await result.current.setRetention(180)
    })

    expect(tauri.setAiAuditRetentionDays).toHaveBeenCalledWith(180)
    expect(result.current.retention).toBe(180)
  })
})
