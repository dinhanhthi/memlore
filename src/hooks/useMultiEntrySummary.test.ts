import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'

vi.mock('../lib/tauri', () => ({
  summariseEntries: vi.fn(),
}))

vi.mock('../lib/estimateSummaryBytes', () => ({
  estimateSummaryBytes: vi.fn(),
}))

import * as tauri from '../lib/tauri'
import * as estimateModule from '../lib/estimateSummaryBytes'
import { useMultiEntrySummary, WARN_BYTES } from './useMultiEntrySummary'
import type { MultiEntrySummaryEntry } from './useMultiEntrySummary'

const SMALL_BYTES = 1000 // < WARN_BYTES
const LARGE_BYTES = 100_000 // > WARN_BYTES

const makeEntry = (id: string): MultiEntrySummaryEntry => ({
  id,
  title: 'Test entry',
  content_text: 'Some content here.',
  entry_date: 1_700_000_000,
})

beforeEach(() => {
  vi.clearAllMocks()
  // Default: small payload
  vi.mocked(estimateModule.estimateSummaryBytes).mockReturnValue(SMALL_BYTES)
  // Default: summariseEntries resolves with markdown
  vi.mocked(tauri.summariseEntries).mockResolvedValue('## bullet')
})

describe('useMultiEntrySummary', () => {
  it('1. initial state is idle', () => {
    const { result } = renderHook(() => useMultiEntrySummary())
    expect(result.current.state).toEqual({ kind: 'idle' })
  })

  it('2. request with empty entries sets error AI_NO_ENTRIES', () => {
    const { result } = renderHook(() => useMultiEntrySummary())
    act(() => {
      result.current.request([])
    })
    expect(result.current.state).toEqual({ kind: 'error', code: 'AI_NO_ENTRIES' })
  })

  it('3. request with small payload skips confirmation and resolves to done', async () => {
    vi.mocked(estimateModule.estimateSummaryBytes).mockReturnValue(SMALL_BYTES)
    vi.mocked(tauri.summariseEntries).mockResolvedValue('## bullet')

    const { result } = renderHook(() => useMultiEntrySummary())
    act(() => {
      result.current.request([makeEntry('id1')])
    })

    // Should jump straight to loading (not pending_confirmation)
    expect(result.current.state.kind).toBe('loading')

    await waitFor(() => {
      expect(result.current.state).toEqual({ kind: 'done', markdown: '## bullet' })
    })
  })

  it('4. request with large payload sets pending_confirmation with estimatedBytes', () => {
    vi.mocked(estimateModule.estimateSummaryBytes).mockReturnValue(LARGE_BYTES)

    const { result } = renderHook(() => useMultiEntrySummary())
    act(() => {
      result.current.request([makeEntry('id1')])
    })

    expect(result.current.state).toEqual({
      kind: 'pending_confirmation',
      estimatedBytes: LARGE_BYTES,
    })
  })

  it('5. confirm("truncate") from pending_confirmation transitions to done', async () => {
    vi.mocked(estimateModule.estimateSummaryBytes).mockReturnValue(LARGE_BYTES)
    vi.mocked(tauri.summariseEntries).mockResolvedValue('- point one')

    const { result } = renderHook(() => useMultiEntrySummary())

    // Trigger large payload → pending_confirmation
    act(() => {
      result.current.request([makeEntry('id1')])
    })
    expect(result.current.state.kind).toBe('pending_confirmation')

    // Confirm with truncate
    act(() => {
      result.current.confirm('truncate')
    })
    expect(result.current.state.kind).toBe('loading')

    await waitFor(() => {
      expect(result.current.state).toEqual({ kind: 'done', markdown: '- point one' })
    })

    expect(vi.mocked(tauri.summariseEntries)).toHaveBeenCalledWith(['id1'], 'truncate')
  })

  it('6. confirm("raw") from pending_confirmation transitions to done', async () => {
    vi.mocked(estimateModule.estimateSummaryBytes).mockReturnValue(LARGE_BYTES)
    vi.mocked(tauri.summariseEntries).mockResolvedValue('- point raw')

    const { result } = renderHook(() => useMultiEntrySummary())

    act(() => {
      result.current.request([makeEntry('id1')])
    })
    expect(result.current.state.kind).toBe('pending_confirmation')

    act(() => {
      result.current.confirm('raw')
    })

    await waitFor(() => {
      expect(result.current.state).toEqual({ kind: 'done', markdown: '- point raw' })
    })

    expect(vi.mocked(tauri.summariseEntries)).toHaveBeenCalledWith(['id1'], 'raw')
  })

  it('7. confirm before request is a no-op (state stays idle)', () => {
    const { result } = renderHook(() => useMultiEntrySummary())
    act(() => {
      result.current.confirm('truncate')
    })
    expect(result.current.state).toEqual({ kind: 'idle' })
    expect(vi.mocked(tauri.summariseEntries)).not.toHaveBeenCalled()
  })

  it('8. backend error (Tauri plain string) is unwrapped to the inner code', async () => {
    // Tauri rejects `Result<_, String>` with a plain JS string, NOT an
    // Error instance. `extractAiErrorCode` strips the `AI_PROVIDER_ERROR: `
    // wrapper so the stored code is the bare inner code.
    vi.mocked(estimateModule.estimateSummaryBytes).mockReturnValue(SMALL_BYTES)
    vi.mocked(tauri.summariseEntries).mockRejectedValue(
      'AI_PROVIDER_ERROR: AI_NO_ENTRIES_WITH_CONTENT',
    )

    const { result } = renderHook(() => useMultiEntrySummary())
    act(() => {
      result.current.request([makeEntry('id1')])
    })

    await waitFor(() => {
      expect(result.current.state).toEqual({
        kind: 'error',
        code: 'AI_NO_ENTRIES_WITH_CONTENT',
      })
    })
  })

  it('8b. backend error from Error instance falls back to .message', async () => {
    // Belt-and-suspenders: if a future Tauri version starts wrapping
    // rejections in Error instances, the hook still extracts the code.
    vi.mocked(estimateModule.estimateSummaryBytes).mockReturnValue(SMALL_BYTES)
    vi.mocked(tauri.summariseEntries).mockRejectedValue(new Error('AI_RATE_LIMITED'))

    const { result } = renderHook(() => useMultiEntrySummary())
    act(() => {
      result.current.request([makeEntry('id1')])
    })

    await waitFor(() => {
      expect(result.current.state).toEqual({
        kind: 'error',
        code: 'AI_RATE_LIMITED',
      })
    })
  })

  it('9. dismiss returns to idle from any state', async () => {
    vi.mocked(estimateModule.estimateSummaryBytes).mockReturnValue(SMALL_BYTES)
    vi.mocked(tauri.summariseEntries).mockResolvedValue('- done')

    const { result } = renderHook(() => useMultiEntrySummary())

    // Get to done state first
    act(() => {
      result.current.request([makeEntry('id1')])
    })
    await waitFor(() => {
      expect(result.current.state.kind).toBe('done')
    })

    // Dismiss should reset to idle
    act(() => {
      result.current.dismiss()
    })
    expect(result.current.state).toEqual({ kind: 'idle' })
  })
})

describe('WARN_BYTES constant', () => {
  it('is 80 KB', () => {
    expect(WARN_BYTES).toBe(80 * 1024)
  })
})
