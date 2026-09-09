import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tag } from '../types/journal'
import { useInvisibleLockStore } from '../stores/invisibleLockStore'
import { EMPTY_TAGS, useEntryTags } from './useEntryTags'

vi.mock('../lib/tauri', () => ({
  getTagsForEntries: vi.fn(),
}))

import { getTagsForEntries } from '../lib/tauri'

const mockGetTagsForEntries = vi.mocked(getTagsForEntries)

function makeTag(id: string, name: string): Tag {
  return { id, name, color: null }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.resetAllMocks()
  useInvisibleLockStore.setState({ activeVaultId: null })
})

describe('useEntryTags', () => {
  it('returns stable empty values without IPC for empty ids', () => {
    const { result } = renderHook(() => useEntryTags([]))

    expect(result.current.size).toBe(0)
    expect(mockGetTagsForEntries).not.toHaveBeenCalled()
    expect(Object.isFrozen(EMPTY_TAGS)).toBe(true)
  })

  it('returns fetched tags as a map', async () => {
    const tag = makeTag('tag-1', 'work')
    mockGetTagsForEntries.mockResolvedValue({ 'entry-1': [tag] })

    const { result } = renderHook(() => useEntryTags(['entry-1']))

    expect(result.current.size).toBe(0)
    await waitFor(() => expect(result.current.get('entry-1')).toEqual([tag]))
    expect(mockGetTagsForEntries).toHaveBeenCalledWith(['entry-1'], null)
  })

  it('does not refetch for a new array with the same distinct ids', async () => {
    mockGetTagsForEntries.mockResolvedValue({})
    const { rerender } = renderHook(
      ({ entryIds }: { entryIds: string[] }) => useEntryTags(entryIds),
      { initialProps: { entryIds: ['entry-2', 'entry-1'] } },
    )
    await waitFor(() => expect(mockGetTagsForEntries).toHaveBeenCalledTimes(1))

    rerender({ entryIds: ['entry-1', 'entry-2', 'entry-1'] })

    expect(mockGetTagsForEntries).toHaveBeenCalledTimes(1)
    expect(mockGetTagsForEntries).toHaveBeenCalledWith(['entry-1', 'entry-2'], null)
  })

  it.each([
    ['tags', 'memlore:tags-changed'],
    ['entries', 'memlore:entries-changed'],
  ])('clears loaded tags immediately when %s change', async (_label, eventName) => {
    const refreshed = deferred<Record<string, Tag[]>>()
    const oldTag = makeTag('tag-old', 'old')
    const freshTag = makeTag('tag-fresh', 'fresh')
    mockGetTagsForEntries
      .mockResolvedValueOnce({ 'entry-1': [oldTag] })
      .mockReturnValueOnce(refreshed.promise)
    const { result } = renderHook(() => useEntryTags(['entry-1']))
    await waitFor(() => expect(result.current.get('entry-1')).toEqual([oldTag]))

    act(() => window.dispatchEvent(new CustomEvent(eventName)))

    expect(result.current.size).toBe(0)
    await waitFor(() => expect(mockGetTagsForEntries).toHaveBeenCalledTimes(2))
    await act(async () => {
      refreshed.resolve({ 'entry-1': [freshTag] })
      await refreshed.promise
    })
    await waitFor(() => expect(result.current.get('entry-1')).toEqual([freshTag]))
  })

  it('keeps the newest event response when the initial request resolves last', async () => {
    const initial = deferred<Record<string, Tag[]>>()
    const refreshed = deferred<Record<string, Tag[]>>()
    const staleTag = makeTag('tag-stale', 'stale')
    const freshTag = makeTag('tag-fresh', 'fresh')
    mockGetTagsForEntries
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(refreshed.promise)
    const { result } = renderHook(() => useEntryTags(['entry-1']))
    await waitFor(() => expect(mockGetTagsForEntries).toHaveBeenCalledTimes(1))

    act(() => window.dispatchEvent(new CustomEvent('memlore:tags-changed')))
    await waitFor(() => expect(mockGetTagsForEntries).toHaveBeenCalledTimes(2))
    await act(async () => {
      refreshed.resolve({ 'entry-1': [freshTag] })
      await refreshed.promise
    })
    await waitFor(() => expect(result.current.get('entry-1')).toEqual([freshTag]))

    await act(async () => {
      initial.resolve({ 'entry-1': [staleTag] })
      await initial.promise
    })

    expect(result.current.get('entry-1')).toEqual([freshTag])
  })

  it('ignores the previous ID-set response after rerender', async () => {
    const entryA = deferred<Record<string, Tag[]>>()
    const entryB = deferred<Record<string, Tag[]>>()
    const tagA = makeTag('tag-a', 'A')
    const tagB = makeTag('tag-b', 'B')
    mockGetTagsForEntries.mockReturnValueOnce(entryA.promise).mockReturnValueOnce(entryB.promise)
    const { result, rerender } = renderHook(
      ({ entryIds }: { entryIds: string[] }) => useEntryTags(entryIds),
      { initialProps: { entryIds: ['entry-a'] } },
    )
    await waitFor(() => expect(mockGetTagsForEntries).toHaveBeenCalledTimes(1))

    rerender({ entryIds: ['entry-b'] })
    await waitFor(() => expect(mockGetTagsForEntries).toHaveBeenCalledTimes(2))
    await act(async () => {
      entryB.resolve({ 'entry-b': [tagB] })
      await entryB.promise
    })
    await waitFor(() => expect(result.current.get('entry-b')).toEqual([tagB]))

    await act(async () => {
      entryA.resolve({ 'entry-a': [tagA] })
      await entryA.promise
    })

    expect(result.current.get('entry-a')).toBeUndefined()
    expect(result.current.get('entry-b')).toEqual([tagB])
  })

  it('clears tags immediately when the requested ID set changes', async () => {
    const entryA = deferred<Record<string, Tag[]>>()
    const entryB = deferred<Record<string, Tag[]>>()
    const tagA = makeTag('tag-a', 'A')
    const tagB = makeTag('tag-b', 'B')
    mockGetTagsForEntries.mockReturnValueOnce(entryA.promise).mockReturnValueOnce(entryB.promise)
    const { result, rerender } = renderHook(
      ({ entryIds }: { entryIds: string[] }) => useEntryTags(entryIds),
      { initialProps: { entryIds: ['entry-a'] } },
    )
    await waitFor(() => expect(mockGetTagsForEntries).toHaveBeenCalledTimes(1))
    await act(async () => {
      entryA.resolve({ 'entry-a': [tagA] })
      await entryA.promise
    })
    await waitFor(() => expect(result.current.get('entry-a')).toEqual([tagA]))

    rerender({ entryIds: ['entry-b'] })

    expect(result.current.size).toBe(0)
    await waitFor(() => expect(mockGetTagsForEntries).toHaveBeenCalledTimes(2))
    await act(async () => {
      entryB.resolve({ 'entry-b': [tagB] })
      await entryB.promise
    })

    await waitFor(() => expect(result.current.get('entry-b')).toEqual([tagB]))
    expect(result.current.get('entry-a')).toBeUndefined()
  })

  it('keeps tags empty while cycling from A through B and back to A', async () => {
    const entryB = deferred<Record<string, Tag[]>>()
    const freshEntryA = deferred<Record<string, Tag[]>>()
    const oldTagA = makeTag('tag-a-old', 'A old')
    const freshTagA = makeTag('tag-a-fresh', 'A fresh')
    const tagB = makeTag('tag-b', 'B')
    mockGetTagsForEntries
      .mockResolvedValueOnce({ 'entry-a': [oldTagA] })
      .mockReturnValueOnce(entryB.promise)
      .mockReturnValueOnce(freshEntryA.promise)
    const { result, rerender } = renderHook(
      ({ entryIds }: { entryIds: string[] }) => useEntryTags(entryIds),
      { initialProps: { entryIds: ['entry-a'] } },
    )
    await waitFor(() => expect(result.current.get('entry-a')).toEqual([oldTagA]))

    rerender({ entryIds: ['entry-b'] })
    expect(result.current.size).toBe(0)
    await waitFor(() => expect(mockGetTagsForEntries).toHaveBeenCalledTimes(2))

    rerender({ entryIds: ['entry-a'] })

    expect(result.current.size).toBe(0)
    await waitFor(() => expect(mockGetTagsForEntries).toHaveBeenCalledTimes(3))
    await act(async () => {
      freshEntryA.resolve({ 'entry-a': [freshTagA] })
      await freshEntryA.promise
    })
    await waitFor(() => expect(result.current.get('entry-a')).toEqual([freshTagA]))

    await act(async () => {
      entryB.resolve({ 'entry-b': [tagB] })
      await entryB.promise
    })
    expect(result.current.get('entry-a')).toEqual([freshTagA])
    expect(result.current.get('entry-b')).toBeUndefined()
  })

  it('keeps tags empty while cycling from A through empty and back to A', async () => {
    const freshEntryA = deferred<Record<string, Tag[]>>()
    const oldTagA = makeTag('tag-a-old', 'A old')
    const freshTagA = makeTag('tag-a-fresh', 'A fresh')
    mockGetTagsForEntries
      .mockResolvedValueOnce({ 'entry-a': [oldTagA] })
      .mockReturnValueOnce(freshEntryA.promise)
    const { result, rerender } = renderHook(
      ({ entryIds }: { entryIds: string[] }) => useEntryTags(entryIds),
      { initialProps: { entryIds: ['entry-a'] } },
    )
    await waitFor(() => expect(result.current.get('entry-a')).toEqual([oldTagA]))

    rerender({ entryIds: [] })
    expect(result.current.size).toBe(0)
    expect(mockGetTagsForEntries).toHaveBeenCalledTimes(1)

    rerender({ entryIds: ['entry-a'] })

    expect(result.current.size).toBe(0)
    await waitFor(() => expect(mockGetTagsForEntries).toHaveBeenCalledTimes(2))
    await act(async () => {
      freshEntryA.resolve({ 'entry-a': [freshTagA] })
      await freshEntryA.promise
    })
    await waitFor(() => expect(result.current.get('entry-a')).toEqual([freshTagA]))
  })

  it('does not restore revealed tags after the invisible session relocks', async () => {
    useInvisibleLockStore.setState({ activeVaultId: 'vault-a' })
    const revealed = deferred<Record<string, Tag[]>>()
    const hidden = deferred<Record<string, Tag[]>>()
    const visibleTag = makeTag('tag-visible', 'visible')
    const secretTag = makeTag('tag-secret', 'secret')
    mockGetTagsForEntries.mockReturnValueOnce(revealed.promise).mockReturnValueOnce(hidden.promise)
    const { result } = renderHook(() => useEntryTags(['visible-entry', 'secret-entry']))
    await waitFor(() =>
      expect(mockGetTagsForEntries).toHaveBeenCalledWith(
        ['secret-entry', 'visible-entry'],
        'vault-a',
      ),
    )

    act(() => useInvisibleLockStore.setState({ activeVaultId: null }))
    await waitFor(() =>
      expect(mockGetTagsForEntries).toHaveBeenLastCalledWith(
        ['secret-entry', 'visible-entry'],
        null,
      ),
    )
    await act(async () => {
      hidden.resolve({ 'visible-entry': [visibleTag] })
      await hidden.promise
    })
    await waitFor(() => expect(result.current.get('visible-entry')).toEqual([visibleTag]))

    await act(async () => {
      revealed.resolve({
        'visible-entry': [visibleTag],
        'secret-entry': [secretTag],
      })
      await revealed.promise
    })

    expect(result.current.get('visible-entry')).toEqual([visibleTag])
    expect(result.current.get('secret-entry')).toBeUndefined()
  })

  it('clears revealed tags immediately when the invisible session relocks', async () => {
    useInvisibleLockStore.setState({ activeVaultId: 'vault-a' })
    const revealed = deferred<Record<string, Tag[]>>()
    const hidden = deferred<Record<string, Tag[]>>()
    const visibleTag = makeTag('tag-visible', 'visible')
    const secretTag = makeTag('tag-secret', 'secret')
    mockGetTagsForEntries.mockReturnValueOnce(revealed.promise).mockReturnValueOnce(hidden.promise)
    const { result } = renderHook(() => useEntryTags(['visible-entry', 'secret-entry']))
    await waitFor(() =>
      expect(mockGetTagsForEntries).toHaveBeenCalledWith(
        ['secret-entry', 'visible-entry'],
        'vault-a',
      ),
    )
    await act(async () => {
      revealed.resolve({
        'visible-entry': [visibleTag],
        'secret-entry': [secretTag],
      })
      await revealed.promise
    })
    await waitFor(() => expect(result.current.get('secret-entry')).toEqual([secretTag]))

    act(() => useInvisibleLockStore.setState({ activeVaultId: null }))

    expect(result.current.size).toBe(0)
    await waitFor(() =>
      expect(mockGetTagsForEntries).toHaveBeenLastCalledWith(
        ['secret-entry', 'visible-entry'],
        null,
      ),
    )
    await act(async () => {
      hidden.resolve({ 'visible-entry': [visibleTag] })
      await hidden.promise
    })

    await waitFor(() => expect(result.current.get('visible-entry')).toEqual([visibleTag]))
    expect(result.current.get('secret-entry')).toBeUndefined()
  })

  it('ignores a response that resolves after unmount', async () => {
    const pending = deferred<Record<string, Tag[]>>()
    mockGetTagsForEntries.mockReturnValue(pending.promise)
    const tag = makeTag('tag-1', 'work')
    const { result, unmount } = renderHook(() => useEntryTags(['entry-1']))
    await waitFor(() => expect(mockGetTagsForEntries).toHaveBeenCalledTimes(1))

    unmount()
    await act(async () => {
      pending.resolve({ 'entry-1': [tag] })
      await pending.promise
    })

    expect(result.current.size).toBe(0)
  })
})
