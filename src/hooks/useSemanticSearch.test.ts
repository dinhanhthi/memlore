import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useSemanticSearch } from './useSemanticSearch'
import { useInvisibleLockStore } from '../stores/invisibleLockStore'
import { useSecondLockStore } from '../stores/secondLockStore'
import type { SearchFilters, SemanticHit } from '../types/entry'

vi.mock('../lib/tauri', () => ({
  semanticSearch: vi.fn(),
}))

import * as tauri from '../lib/tauri'

const makeHit = (overrides: Partial<SemanticHit> = {}): SemanticHit => ({
  entry_id: 'h1',
  title: 'Result',
  snippet: 'preview',
  score: 0.87,
  entry_date: 1_700_000_000,
  ...overrides,
})

beforeEach(() => {
  vi.resetAllMocks()
  useInvisibleLockStore.setState({ activeVaultId: 'vault-a', autoLockMinutes: 5 })
  // Second lock disabled → lockedView() === 'revealed' (search allowed).
  // showExistence pinned so the second-lock test's expected 'hidden' is stable.
  useSecondLockStore.setState({ isEnabled: false, isSessionUnlocked: false, showExistence: false })
})

describe('useSemanticSearch', () => {
  it('returns empty results and does not call backend for blank query', async () => {
    const { result } = renderHook(() => useSemanticSearch(''))
    await new Promise((r) => setTimeout(r, 50))
    expect(result.current.results).toEqual([])
    expect(result.current.isLoading).toBe(false)
    expect(tauri.semanticSearch).not.toHaveBeenCalled()
  })

  it('returns empty results for whitespace-only query', async () => {
    renderHook(() => useSemanticSearch('   '))
    await new Promise((r) => setTimeout(r, 50))
    expect(tauri.semanticSearch).not.toHaveBeenCalled()
  })

  it('searches with reveal_invisible=false when invisible session is locked', async () => {
    // The backend excludes invisible entries server-side via the flag, so a
    // locked invisible session must NOT block semantic search — it just scopes
    // results to visible entries (mirrors keyword search).
    useInvisibleLockStore.setState({ activeVaultId: null, autoLockMinutes: 5 })
    const visibleHit = makeHit({ entry_id: 'v1', title: 'Visible' })
    vi.mocked(tauri.semanticSearch).mockResolvedValue([visibleHit])

    const { result } = renderHook(() => useSemanticSearch('hidden memory'))

    await waitFor(() =>
      expect(tauri.semanticSearch).toHaveBeenCalledWith(
        'hidden memory',
        20,
        undefined,
        'revealed',
        null,
      ),
    )
    await waitFor(() => expect(result.current.results).toEqual([visibleHit]))
    expect(result.current.isLoading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('forwards lockedView=hidden so the backend excludes second-lock entries', async () => {
    // `semantic_search` now takes locked_view, so second lock no longer blocks
    // search — the backend excludes locked entries (Covered treated as Hidden)
    // and returns visible-only hits, mirroring keyword search.
    useSecondLockStore.setState({ isEnabled: true, isSessionUnlocked: false })
    const visibleHit = makeHit({ entry_id: 'v1', title: 'Visible' })
    vi.mocked(tauri.semanticSearch).mockResolvedValue([visibleHit])

    const { result } = renderHook(() => useSemanticSearch('locked memory'))

    await waitFor(() =>
      expect(tauri.semanticSearch).toHaveBeenCalledWith(
        'locked memory',
        20,
        undefined,
        'hidden',
        'vault-a',
      ),
    )
    await waitFor(() => expect(result.current.results).toEqual([visibleHit]))
    expect(result.current.error).toBeNull()
  })

  it('forwards lockedView=revealed when second lock is enabled but unlocked', async () => {
    // Third lockedView state: enabled + unlocked → 'revealed' → backend sees
    // everything. Completes coverage of the guard-removal across all three states.
    useSecondLockStore.setState({ isEnabled: true, isSessionUnlocked: true })
    vi.mocked(tauri.semanticSearch).mockResolvedValue([])

    renderHook(() => useSemanticSearch('unlocked memory'))

    await waitFor(() =>
      expect(tauri.semanticSearch).toHaveBeenCalledWith(
        'unlocked memory',
        20,
        undefined,
        'revealed',
        'vault-a',
      ),
    )
  })

  it('debounces and calls backend after the debounce window', async () => {
    vi.mocked(tauri.semanticSearch).mockResolvedValue([makeHit()])

    const { result } = renderHook(() => useSemanticSearch('feeling overwhelmed'))
    expect(result.current.isLoading).toBe(true)
    expect(tauri.semanticSearch).not.toHaveBeenCalled()

    await waitFor(() =>
      expect(tauri.semanticSearch).toHaveBeenCalledWith(
        'feeling overwhelmed',
        20,
        undefined,
        'revealed',
        'vault-a',
      ),
    )
  })

  it('accepts filters and forwards them to the backend', async () => {
    vi.mocked(tauri.semanticSearch).mockResolvedValue([])
    const filters: SearchFilters = { emotions: ['good'] }
    renderHook(() => useSemanticSearch('q', filters))
    await waitFor(() =>
      expect(tauri.semanticSearch).toHaveBeenCalledWith('q', 20, filters, 'revealed', 'vault-a'),
    )
  })

  it('trims query before sending to backend', async () => {
    vi.mocked(tauri.semanticSearch).mockResolvedValue([])
    renderHook(() => useSemanticSearch('  padded  '))
    await waitFor(() =>
      expect(tauri.semanticSearch).toHaveBeenCalledWith(
        'padded',
        20,
        undefined,
        'revealed',
        'vault-a',
      ),
    )
  })

  it('only calls backend once when query changes rapidly', async () => {
    vi.mocked(tauri.semanticSearch).mockResolvedValue([])
    const { rerender } = renderHook(({ q }: { q: string }) => useSemanticSearch(q), {
      initialProps: { q: 'a' },
    })
    rerender({ q: 'ab' })
    rerender({ q: 'abc' })
    await waitFor(() =>
      expect(tauri.semanticSearch).toHaveBeenCalledWith(
        'abc',
        20,
        undefined,
        'revealed',
        'vault-a',
      ),
    )
    expect(tauri.semanticSearch).toHaveBeenCalledTimes(1)
  })

  it('populates results on successful search', async () => {
    const found = [makeHit({ entry_id: 'x1', title: 'Hit', score: 0.95 })]
    vi.mocked(tauri.semanticSearch).mockResolvedValue(found)

    const { result } = renderHook(() => useSemanticSearch('hit'))

    await waitFor(() => expect(result.current.results).toEqual(found))
    expect(result.current.isLoading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('sets error on backend failure', async () => {
    vi.mocked(tauri.semanticSearch).mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useSemanticSearch('x'))
    await waitFor(() => expect(result.current.error).toBe('boom'))
    expect(result.current.isLoading).toBe(false)
  })

  it('clears results when query is cleared', async () => {
    vi.mocked(tauri.semanticSearch).mockResolvedValue([makeHit()])

    const { result, rerender } = renderHook(({ q }: { q: string }) => useSemanticSearch(q), {
      initialProps: { q: 'hello' },
    })
    await waitFor(() => expect(result.current.results).toHaveLength(1))

    rerender({ q: '' })
    expect(result.current.results).toEqual([])
  })
})
