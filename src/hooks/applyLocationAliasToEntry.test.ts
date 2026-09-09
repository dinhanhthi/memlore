import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Entry } from '../types/entry'
import type { LocationAlias } from '../types/location'
import { useEntryLocationPendingStore } from '../stores/entryLocationPendingStore'

vi.mock('../lib/tauri', () => ({
  updateEntryLocation: vi.fn(),
}))

vi.mock('./applyEntryWeather', () => ({
  applyEntryWeather: vi.fn(),
}))

vi.mock('./useEntries', () => ({
  emitEntriesChanged: vi.fn(),
  emitEntryPatched: vi.fn(),
}))

import { applyLocationAliasToEntry } from './applyLocationAliasToEntry'
import { updateEntryLocation } from '../lib/tauri'
import { applyEntryWeather } from './applyEntryWeather'
import { emitEntriesChanged, emitEntryPatched } from './useEntries'

const alias: LocationAlias = {
  id: 'alias-1',
  label: 'Home',
  address: '123 Main St',
  latitude: 37.7749,
  longitude: -122.4194,
  radius_meters: 100,
}

const updatedEntry = (overrides: Partial<Entry> = {}): Entry => ({
  id: 'entry-1',
  journal_id: 'journal-1',
  title: null,
  preview_text: null,
  content_text: null,
  entry_date: 1_700_000_000,
  created_at: 1_700_000_000,
  updated_at: 1_700_000_000,
  latitude: alias.latitude,
  longitude: alias.longitude,
  location_label: alias.label,
  location_address: alias.address,
  weather_summary: null,
  weather_icon: null,
  emotion: null,
  is_favorite: false,
  is_deleted: false,
  is_locked: false,
  is_invisible: false,
  vault_id: null,
  cover_media_id: null,
  content_language: null,
  entry_date_user_edited: false,
  media_count: 0,
  from_chat: false,
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  useEntryLocationPendingStore.setState({ pendingIds: new Set() })
  vi.mocked(applyEntryWeather).mockResolvedValue(null)
})

describe('applyLocationAliasToEntry', () => {
  it('marks the entry pending before the location IPC resolves', async () => {
    let resolveUpdate: (entry: Entry) => void = () => {}
    vi.mocked(updateEntryLocation).mockReturnValue(
      new Promise((resolve) => {
        resolveUpdate = resolve
      }),
    )

    const done = applyLocationAliasToEntry('entry-1', alias, 1_700_000_000)

    expect(useEntryLocationPendingStore.getState().isPending('entry-1')).toBe(true)

    resolveUpdate(updatedEntry())
    await done

    expect(useEntryLocationPendingStore.getState().isPending('entry-1')).toBe(false)
  })

  it('persists the alias and patches the entry list before weather returns', async () => {
    const saved = updatedEntry()
    vi.mocked(updateEntryLocation).mockResolvedValue(saved)
    let resolveWeather: (value: null) => void = () => {}
    vi.mocked(applyEntryWeather).mockReturnValue(
      new Promise((resolve) => {
        resolveWeather = resolve
      }),
    )

    const done = applyLocationAliasToEntry('entry-1', alias, 1_700_000_000)
    await vi.waitFor(() => {
      expect(useEntryLocationPendingStore.getState().isPending('entry-1')).toBe(false)
    })

    expect(updateEntryLocation).toHaveBeenCalledWith(
      'entry-1',
      alias.latitude,
      alias.longitude,
      alias.label,
      alias.address,
    )
    expect(emitEntryPatched).toHaveBeenCalledWith('entry-1', {
      latitude: saved.latitude,
      longitude: saved.longitude,
      location_label: saved.location_label,
      location_address: saved.location_address,
    })
    expect(emitEntriesChanged).toHaveBeenCalled()

    resolveWeather(null)
    await done
    expect(applyEntryWeather).toHaveBeenCalledWith(
      'entry-1',
      alias.latitude,
      alias.longitude,
      1_700_000_000,
    )
  })

  it('clears pending when the location update fails', async () => {
    vi.mocked(updateEntryLocation).mockRejectedValue(new Error('db'))

    await expect(
      applyLocationAliasToEntry('entry-1', alias, 1_700_000_000),
    ).resolves.toBeUndefined()

    expect(useEntryLocationPendingStore.getState().isPending('entry-1')).toBe(false)
    expect(emitEntryPatched).not.toHaveBeenCalled()
    expect(applyEntryWeather).not.toHaveBeenCalled()
  })
})
