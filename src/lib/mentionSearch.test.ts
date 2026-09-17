import { describe, it, expect, beforeEach, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { createRequestGuard, searchMentionCandidates } from './mentionSearch'
import {
  __resetMentionIncludeLockedForTests,
  setMentionIncludeLocked,
} from '../hooks/useMentionIncludeLocked'
import { useInvisibleLockStore } from '../stores/invisibleLockStore'
import { useSecondLockStore } from '../stores/secondLockStore'
import type { SearchResult } from '../types/entry'

const mockedInvoke = vi.mocked(invoke)

const makeResult = (overrides: Partial<SearchResult> = {}): SearchResult => ({
  id: 'e1',
  journal_id: 'j1',
  title: 'Trip to Hue',
  preview_text: 'preview',
  entry_date: 1_700_000_000,
  ...overrides,
})

/** Make `search_entries` resolve with `results`; every other command → null. */
function mockSearchEntries(results: SearchResult[]): void {
  mockedInvoke.mockImplementation(async (cmd) => (cmd === 'search_entries' ? results : null))
}

beforeEach(() => {
  mockedInvoke.mockReset()
  mockedInvoke.mockImplementation(async () => null)
  __resetMentionIncludeLockedForTests()
  useSecondLockStore.setState({
    isEnabled: false,
    isSessionUnlocked: false,
    showExistence: false,
  })
  useInvisibleLockStore.setState({ activeVaultId: null })
})

describe('searchMentionCandidates', () => {
  it('returns [] without any IPC call for an empty query', async () => {
    expect(await searchMentionCandidates('', {})).toEqual([])
    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it('returns [] without any IPC call for a whitespace-only query', async () => {
    expect(await searchMentionCandidates('   ', {})).toEqual([])
    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it('forces hidden/null when the include-locked setting is off, even with unlocked stores', async () => {
    // Stores say everything is unlocked — the setting must still win.
    useSecondLockStore.setState({ isEnabled: true, isSessionUnlocked: true })
    useInvisibleLockStore.setState({ activeVaultId: 'vault-1' })
    mockSearchEntries([])

    await searchMentionCandidates('hue', {})

    expect(mockedInvoke).toHaveBeenCalledWith(
      'search_entries',
      expect.objectContaining({
        query: 'hue',
        lockedView: 'hidden',
        activeVaultId: null,
        mentionMode: true,
      }),
    )
  })

  it('forwards the real store values when the setting is on', async () => {
    await setMentionIncludeLocked(true)
    useSecondLockStore.setState({
      isEnabled: true,
      isSessionUnlocked: false,
      showExistence: true,
    })
    useInvisibleLockStore.setState({ activeVaultId: 'vault-1' })
    mockSearchEntries([])

    await searchMentionCandidates('hue', {})

    expect(mockedInvoke).toHaveBeenCalledWith(
      'search_entries',
      expect.objectContaining({
        lockedView: 'covered',
        activeVaultId: 'vault-1',
        mentionMode: true,
      }),
    )
  })

  it('drops the entry currently being edited', async () => {
    mockSearchEntries([makeResult({ id: 'e1' }), makeResult({ id: 'e2' })])

    const candidates = await searchMentionCandidates('hue', { excludeEntryId: 'e1' })

    expect(candidates.map((c) => c.id)).toEqual(['e2'])
  })

  it('caps the result at 8', async () => {
    mockSearchEntries(Array.from({ length: 12 }, (_, i) => makeResult({ id: `e${i}` })))

    const candidates = await searchMentionCandidates('hue', {})

    expect(candidates).toHaveLength(8)
    expect(candidates[0]).toEqual({
      id: 'e0',
      label: 'Trip to Hue',
      journalId: 'j1',
      preview: 'preview',
      entryDate: 1_700_000_000,
    })
  })

  it('falls back to the untitled label for null or blank titles', async () => {
    mockSearchEntries([
      makeResult({ id: 'e1', title: null }),
      makeResult({ id: 'e2', title: '   ' }),
    ])

    const candidates = await searchMentionCandidates('hue', {})

    expect(candidates.map((c) => c.label)).toEqual(['Untitled', 'Untitled'])
  })
})

describe('createRequestGuard', () => {
  it('reports older sequence numbers as stale and the newest as current', () => {
    const guard = createRequestGuard()
    const first = guard.next()
    const second = guard.next()

    expect(guard.isCurrent(first)).toBe(false)
    expect(guard.isCurrent(second)).toBe(true)
  })
})
