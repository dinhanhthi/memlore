import { renderHook, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { usePagedQuery } from './usePagedQuery'
import { useTabStore, makeDefaultTab } from '../stores/tabStore'
import type { Tab } from '../stores/tabStore'
import type { PagedResult, PaginatedViewKey } from '../types/pagination'
import { PAGE_SIZE } from '../types/pagination'

// ---------------------------------------------------------------------------
// Store helpers (mirrors tabStore.test.ts pattern)
// ---------------------------------------------------------------------------

function makeTab(overrides: Partial<Tab> = {}): Tab {
  return {
    ...makeDefaultTab(),
    id: 'tab-1',
    dirty: false,
    ...overrides,
  }
}

function seedStore(tab: Tab) {
  useTabStore.setState({ tabs: [tab], activeTabId: tab.id })
}

const VIEW_KEY: PaginatedViewKey = 'all'

beforeEach(() => {
  // Reset to a fresh tab with no pagination state
  seedStore(makeTab())
})

afterEach(() => {
  localStorage.clear()
})

// ---------------------------------------------------------------------------
// Helper: create a stable fetcher that returns the given result immediately
// ---------------------------------------------------------------------------
function makeFetcher<T>(result: PagedResult<T>) {
  return vi.fn(async (_page: number) => result)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('usePagedQuery', () => {
  it('1. initial load returns items, total, totalPages, page=1, isLoading=false', async () => {
    const fetcher = makeFetcher({ items: [1, 2, 3], total: 25 })

    const { result } = renderHook(() =>
      usePagedQuery({ viewKey: VIEW_KEY, fetcher, fingerprint: 'fp-a' }),
    )

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.items).toEqual([1, 2, 3])
    expect(result.current.total).toBe(25)
    // ceil(25 / 20) = 2
    expect(result.current.totalPages).toBe(2)
    expect(result.current.page).toBe(1)
    expect(result.current.error).toBeNull()
  })

  it('2. fingerprint change resets page to 1 and refetches', async () => {
    // Seed tab starting at page 3
    seedStore(makeTab({ pagination: { [VIEW_KEY]: 3 } }))

    const fetcher = makeFetcher({ items: [10], total: 60 })

    const { result, rerender } = renderHook(
      ({ fp }: { fp: string }) => usePagedQuery({ viewKey: VIEW_KEY, fetcher, fingerprint: fp }),
      { initialProps: { fp: 'fp-a' } },
    )

    // Wait for initial load at page 3
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.page).toBe(3)

    // Change fingerprint — should reset to page 1
    rerender({ fp: 'fp-b' })

    await waitFor(() => {
      expect(result.current.page).toBe(1)
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.page).toBe(1)
  })

  it('3. setPage(3) triggers refetch with page=3 and updates tabStore', async () => {
    const fetcher = vi.fn(async (page: number) => ({ items: [page * 10], total: 60 }))

    const { result } = renderHook(() =>
      usePagedQuery({ viewKey: VIEW_KEY, fetcher, fingerprint: 'fp-a' }),
    )

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(fetcher).toHaveBeenCalledWith(1)

    act(() => {
      result.current.setPage(3)
    })

    await waitFor(() => {
      expect(result.current.page).toBe(3)
      expect(result.current.isLoading).toBe(false)
    })

    expect(fetcher).toHaveBeenCalledWith(3)

    // tabStore should reflect the new page
    const tab = useTabStore.getState().tabs.find((t) => t.id === 'tab-1')
    expect(tab?.pagination?.[VIEW_KEY]).toBe(3)
  })

  it('4. invalidate with empty page auto-shifts to page-1 when total > 0', async () => {
    // Start at page 3; 40 total items = 2 full pages of 20, so page 3 is empty
    seedStore(makeTab({ pagination: { [VIEW_KEY]: 3 } }))

    // First call (effect fetch at page 3): returns empty + total=40
    const fetcher = vi.fn(async (_page: number) => ({
      items: [] as number[],
      total: 40,
    }))

    const { result } = renderHook(() =>
      usePagedQuery({ viewKey: VIEW_KEY, fetcher, fingerprint: 'fp-a' }),
    )

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.page).toBe(3)

    // Now invalidate — the page is empty but total > 0 and page > 1
    await act(async () => {
      await result.current.invalidate()
    })

    // Should have shifted to page 2
    await waitFor(() => expect(result.current.page).toBe(2))
  })

  it('5. invalidate at page 1 with empty total stays at page 1', async () => {
    const fetcher = makeFetcher({ items: [] as number[], total: 0 })

    const { result } = renderHook(() =>
      usePagedQuery({ viewKey: VIEW_KEY, fetcher, fingerprint: 'fp-a' }),
    )

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.page).toBe(1)

    await act(async () => {
      await result.current.invalidate()
    })

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.page).toBe(1)
    expect(result.current.items).toEqual([])
    expect(result.current.total).toBe(0)
  })

  it('6. stale response is ignored — only last fetch wins', async () => {
    // Two manually-controlled promises
    let resolve1!: (v: PagedResult<number>) => void
    let resolve2!: (v: PagedResult<number>) => void
    const p1 = new Promise<PagedResult<number>>((r) => {
      resolve1 = r
    })
    const p2 = new Promise<PagedResult<number>>((r) => {
      resolve2 = r
    })

    const fetcher = vi.fn().mockReturnValueOnce(p1).mockReturnValueOnce(p2)

    const { result } = renderHook(() =>
      usePagedQuery({ viewKey: VIEW_KEY, fetcher, fingerprint: 'fp-a' }),
    )

    // Page 1 fetch is in-flight (p1). Now navigate to page 2 (p2 starts).
    act(() => {
      result.current.setPage(2)
    })

    // Resolve page 2 first (faster response)
    await act(async () => {
      resolve2({ items: [99], total: 100 })
    })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
      expect(result.current.items).toEqual([99])
    })

    // Now resolve page 1 (the stale, slower response)
    await act(async () => {
      resolve1({ items: [1, 2, 3], total: 100 })
    })

    // items must still reflect page 2's result
    expect(result.current.items).toEqual([99])
    expect(result.current.page).toBe(2)
  })

  it('7. setPage(0) is clamped to 1 in tabStore', async () => {
    const fetcher = makeFetcher({ items: [1], total: 5 })

    const { result } = renderHook(() =>
      usePagedQuery({ viewKey: VIEW_KEY, fetcher, fingerprint: 'fp-a' }),
    )

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    act(() => {
      result.current.setPage(0)
    })

    await waitFor(() => {
      const tab = useTabStore.getState().tabs.find((t) => t.id === 'tab-1')
      expect(tab?.pagination?.[VIEW_KEY]).toBe(1)
    })

    expect(result.current.page).toBe(1)
  })

  it('PAGE_SIZE constant is 20 (sanity check for totalPages math)', () => {
    expect(PAGE_SIZE).toBe(20)
  })

  it('uses an optional pageSize override for totalPages', async () => {
    const fetcher = makeFetcher({ items: [1], total: 25 })

    const { result } = renderHook(() =>
      usePagedQuery({
        viewKey: VIEW_KEY,
        fetcher,
        fingerprint: 'fp-page-size',
        pageSize: 10,
      }),
    )

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.totalPages).toBe(3)
  })

  // Regression: the web preview's invoke router returns `null` for
  // unhandled commands (see web/mocks/invokeRouter.ts). A nullish fetcher
  // result must be treated as an empty page rather than throwing on
  // `result.items` — before the null-guard this crashed every usePagedQuery
  // consumer (e.g. DailyChat) on mount.
  it('tolerates a null fetcher result as an empty page', async () => {
    const fetcher = vi.fn(async (_page: number) => null as unknown as PagedResult<number>)

    const { result } = renderHook(() =>
      usePagedQuery({ viewKey: VIEW_KEY, fetcher, fingerprint: 'fp-null' }),
    )

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.items).toEqual([])
    expect(result.current.total).toBe(0)
    expect(result.current.error).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// makeDefaultTab sanity — ensure our makeTab helper produces a valid shape
// ---------------------------------------------------------------------------
describe('usePagedQuery — store integration', () => {
  it('pagination on tab defaults to undefined (→ page 1)', () => {
    const tab = makeDefaultTab()
    expect(tab.pagination).toBeUndefined()
    expect(tab.pagination?.['all'] ?? 1).toBe(1)
  })
})
