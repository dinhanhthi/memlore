import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Entry } from '../types/entry'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

import { invoke } from '@tauri-apps/api/core'
import { useInvisibleLockStore } from '../stores/invisibleLockStore'
import { useSecondLockStore } from '../stores/secondLockStore'
import { trashAgeDays, trashDaysLeft, trashRowStatus, useTrash } from './useTrash'

const mockInvoke = vi.mocked(invoke)
const DAY = 86_400

function trashed(id: string): Entry {
  return {
    id,
    journal_id: 'j1',
    title: `Entry ${id}`,
    preview_text: null,
    content_text: null,
    entry_date: 1_700_000_000,
    created_at: 1_700_000_000,
    updated_at: 1_700_000_000,
    latitude: null,
    longitude: null,
    location_label: null,
    location_address: null,
    weather_summary: null,
    weather_icon: null,
    emotion: null,
    is_favorite: false,
    is_deleted: true,
    is_locked: false,
    is_invisible: false,
    vault_id: null,
    cover_media_id: null,
    content_language: null,
    entry_date_user_edited: false,
    media_count: 0,
    from_chat: false,
    trashed_at: 1_700_000_000,
  }
}

let listed: Entry[] = []
const events: string[] = []
const recordEvent = (e: Event) => events.push(e.type)
const EVENT_NAMES = ['memlore:entries-changed', 'memlore:media-changed', 'memlore:streak-refresh']

beforeEach(() => {
  vi.clearAllMocks()
  listed = [trashed('a'), trashed('b')]
  events.length = 0
  EVENT_NAMES.forEach((n) => window.addEventListener(n, recordEvent))
  useSecondLockStore.setState({ isEnabled: true, isSessionUnlocked: false, showExistence: true })
  useInvisibleLockStore.setState({ activeVaultId: 'vault-1' })
  mockInvoke.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case 'list_trashed_entries':
        return listed
      case 'restore_entry':
      case 'delete_entry_forever':
        return null
      case 'empty_trash':
        return 2
      case 'recalculate_streak':
        return { current_streak: 0, longest_streak: 0 }
      default:
        throw new Error(`unexpected command ${cmd}`)
    }
  })
})

afterEach(() => {
  EVENT_NAMES.forEach((n) => window.removeEventListener(n, recordEvent))
})

describe('trash retention helpers', () => {
  it('counts whole days since trashing and floors days left at 0', () => {
    const now = 1_700_000_000
    expect(trashAgeDays(now - 2 * DAY - 10, now)).toBe(2)
    expect(trashDaysLeft(now - 2 * DAY - 10, now)).toBe(28)
    expect(trashDaysLeft(now, now)).toBe(30)
    // Purge may lag (device offline, clock skew): never show a negative count.
    expect(trashDaysLeft(now - 45 * DAY, now)).toBe(0)
    // A peer clock ahead of ours must not show a negative age.
    expect(trashAgeDays(now + DAY, now)).toBe(0)
  })
})

describe('trashRowStatus', () => {
  const now = 1_700_000_000

  it('is pending for a web delete the desktop has not applied yet', () => {
    const entry = { ...trashed('a'), trash_pending_desktop: true }
    expect(trashRowStatus(entry, now)).toEqual({ kind: 'pending' })
  })

  it('counts days left for a row in the desktop Trash', () => {
    const entry = { ...trashed('a'), trashed_at: now - 2 * DAY }
    expect(trashRowStatus(entry, now)).toEqual({ kind: 'trash', daysLeft: 28 })
  })

  it('treats a row with no trashed_at as just trashed', () => {
    const entry = { ...trashed('a'), trashed_at: null }
    expect(trashRowStatus(entry, now)).toEqual({ kind: 'trash', daysLeft: 30 })
  })
})

describe('useTrash', () => {
  it('lists trashed entries for the current lock view and vault', async () => {
    const { result } = renderHook(() => useTrash())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.entries.map((e) => e.id)).toEqual(['a', 'b'])
    expect(result.current.lockedView).toBe('covered')
    expect(mockInvoke).toHaveBeenCalledWith('list_trashed_entries', {
      lockedView: 'covered',
      activeVaultId: 'vault-1',
    })
  })

  it('refetches when entries change elsewhere', async () => {
    const { result } = renderHook(() => useTrash())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    listed = [trashed('c')]
    act(() => {
      window.dispatchEvent(new CustomEvent('memlore:entries-changed'))
    })
    await waitFor(() => expect(result.current.entries.map((e) => e.id)).toEqual(['c']))
  })

  it.each([
    ['restore', 'restore_entry', { id: 'a', lockedView: 'covered', activeVaultId: 'vault-1' }],
    [
      'deleteForever',
      'delete_entry_forever',
      { id: 'a', lockedView: 'covered', activeVaultId: 'vault-1' },
    ],
  ] as const)('%s calls %s and broadcasts the change events', async (action, cmd, args) => {
    const { result } = renderHook(() => useTrash())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current[action]('a')
    })

    expect(mockInvoke).toHaveBeenCalledWith(cmd, args)
    expect(events).toEqual([
      'memlore:streak-refresh',
      'memlore:entries-changed',
      'memlore:media-changed',
    ])
  })

  it('empty calls empty_trash, returns the purged count, and broadcasts', async () => {
    const { result } = renderHook(() => useTrash())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    let purged = -1
    await act(async () => {
      purged = await result.current.empty()
    })

    expect(purged).toBe(2)
    expect(mockInvoke).toHaveBeenCalledWith('empty_trash', {
      lockedView: 'covered',
      activeVaultId: 'vault-1',
    })
    expect(events).toEqual([
      'memlore:streak-refresh',
      'memlore:entries-changed',
      'memlore:media-changed',
    ])
  })

  it('surfaces a list failure as error and an action failure as a rejection', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_trashed_entries') throw 'db locked'
      if (cmd === 'restore_entry') throw new Error('entry is not in Trash')
      return null
    })
    const { result } = renderHook(() => useTrash())
    await waitFor(() => expect(result.current.error).toBe('db locked'))

    await expect(result.current.restore('a')).rejects.toThrow('entry is not in Trash')
    expect(events).toEqual([])
  })
})
