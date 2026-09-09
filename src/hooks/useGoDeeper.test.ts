import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useGoDeeper } from './useGoDeeper'

vi.mock('../lib/tauri', () => ({
  goDeeper: vi.fn(),
}))

import * as tauri from '../lib/tauri'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useGoDeeper', () => {
  it('starts in idle', () => {
    const { result } = renderHook(() => useGoDeeper())
    expect(result.current.state.kind).toBe('idle')
  })

  it('flips to loading then done when generate resolves with prompts', async () => {
    vi.mocked(tauri.goDeeper).mockResolvedValueOnce(['a?', 'b?', 'c?'])
    // lens defaults to 'default' on generate()
    const { result } = renderHook(() => useGoDeeper())

    await act(async () => {
      void result.current.generate('e1')
    })

    await waitFor(() => {
      expect(result.current.state.kind).toBe('done')
    })
    if (result.current.state.kind === 'done') {
      expect(result.current.state.entryId).toBe('e1')
      expect(result.current.state.prompts).toEqual(['a?', 'b?', 'c?'])
    }
  })

  it('flips to error with the stable code when generate rejects with a string', async () => {
    vi.mocked(tauri.goDeeper).mockRejectedValueOnce('AI_RATE_LIMITED')
    const { result } = renderHook(() => useGoDeeper())

    await act(async () => {
      try {
        await result.current.generate('e1')
      } catch {
        /* swallowed inside hook */
      }
    })

    await waitFor(() => {
      expect(result.current.state.kind).toBe('error')
    })
    if (result.current.state.kind === 'error') {
      expect(result.current.state.code).toBe('AI_RATE_LIMITED')
    }
  })

  it('strips trailing detail after the colon so callers see the bare code', async () => {
    // Backend errors come through as "AI_GO_DEEPER_TOO_SHORT" (single
    // word) or "AI_PROVIDER_ERROR: rate-limit body" — the latter would
    // otherwise leak the body into the i18n key lookup.
    vi.mocked(tauri.goDeeper).mockRejectedValueOnce('AI_PROVIDER_ERROR: 429 body bla')
    const { result } = renderHook(() => useGoDeeper())

    await act(async () => {
      try {
        await result.current.generate('e1')
      } catch {
        /* swallowed inside hook */
      }
    })

    await waitFor(() => {
      expect(result.current.state.kind).toBe('error')
    })
    if (result.current.state.kind === 'error') {
      expect(result.current.state.code).toBe('AI_PROVIDER_ERROR')
    }
  })

  it('unwraps a feature-disabled code carried inside AI_PROVIDER_ERROR', async () => {
    vi.mocked(tauri.goDeeper).mockRejectedValueOnce('AI_PROVIDER_ERROR: AI_GO_DEEPER_DISABLED')
    const { result } = renderHook(() => useGoDeeper())

    await act(async () => {
      try {
        await result.current.generate('e1')
      } catch {
        /* swallowed inside hook */
      }
    })

    await waitFor(() => {
      expect(result.current.state.kind).toBe('error')
    })
    if (result.current.state.kind === 'error') {
      expect(result.current.state.code).toBe('AI_GO_DEEPER_DISABLED')
    }
  })

  it('treats an empty prompts array as AI_EMPTY_RESPONSE error', async () => {
    vi.mocked(tauri.goDeeper).mockResolvedValueOnce([])
    const { result } = renderHook(() => useGoDeeper())

    await act(async () => {
      void result.current.generate('e1')
    })

    await waitFor(() => {
      expect(result.current.state.kind).toBe('error')
    })
    if (result.current.state.kind === 'error') {
      expect(result.current.state.code).toBe('AI_EMPTY_RESPONSE')
    }
  })

  it('dismiss flips back to idle from done', async () => {
    vi.mocked(tauri.goDeeper).mockResolvedValueOnce(['a?'])
    const { result } = renderHook(() => useGoDeeper())

    await act(async () => {
      void result.current.generate('e1')
    })
    await waitFor(() => expect(result.current.state.kind).toBe('done'))

    act(() => {
      result.current.dismiss()
    })
    expect(result.current.state.kind).toBe('idle')
  })

  it('dismiss flips back to idle from error', async () => {
    vi.mocked(tauri.goDeeper).mockRejectedValueOnce('AI_AUTH_FAILED')
    const { result } = renderHook(() => useGoDeeper())

    await act(async () => {
      try {
        await result.current.generate('e1')
      } catch {
        /* */
      }
    })
    await waitFor(() => expect(result.current.state.kind).toBe('error'))

    act(() => {
      result.current.dismiss()
    })
    expect(result.current.state.kind).toBe('idle')
  })

  it('falls back to AI_UNKNOWN_ERROR when rejection is not a string', async () => {
    vi.mocked(tauri.goDeeper).mockRejectedValueOnce(new Error('boom'))
    const { result } = renderHook(() => useGoDeeper())

    await act(async () => {
      try {
        await result.current.generate('e1')
      } catch {
        /* */
      }
    })

    await waitFor(() => expect(result.current.state.kind).toBe('error'))
    if (result.current.state.kind === 'error') {
      expect(result.current.state.code).toBe('AI_UNKNOWN_ERROR')
    }
  })
})
