import { describe, expect, it } from 'vitest'
import { mentionDisplay } from './mentionState'
import type { Entry } from '../types/entry'

const makeEntry = (overrides: Partial<Entry> = {}): Entry => ({
  id: 'e1',
  journal_id: 'j1',
  title: 'Morning walk',
  preview_text: 'p',
  content_text: 'c',
  entry_date: 1_700_000_000,
  created_at: 0,
  updated_at: 0,
  latitude: null,
  longitude: null,
  location_label: null,
  location_address: null,
  weather_summary: null,
  weather_icon: null,
  emotion: null,
  is_favorite: false,
  is_deleted: false,
  is_locked: false,
  is_invisible: false,
  vault_id: null,
  cover_media_id: null,
  media_count: 0,
  from_chat: false,
  content_language: null,
  entry_date_user_edited: false,
  ...overrides,
})

describe('mentionDisplay', () => {
  it('shows the snapshot label while the entry is not fetched yet', () => {
    expect(
      mentionDisplay({
        entry: undefined,
        label: 'Old',
        lockedView: 'revealed',
        activeVaultId: null,
      }),
    ).toEqual({
      title: 'Old',
      unavailable: false,
    })
  })

  it('marks a missing entry unavailable with no title', () => {
    expect(
      mentionDisplay({ entry: null, label: 'Old', lockedView: 'revealed', activeVaultId: null }),
    ).toEqual({
      title: '',
      unavailable: true,
    })
  })

  it('keeps the title of a deleted entry but marks it unavailable', () => {
    expect(
      mentionDisplay({
        entry: makeEntry({ is_deleted: true, title: 'Trashed' }),
        label: 'Old',
        lockedView: 'revealed',
        activeVaultId: null,
      }),
    ).toEqual({ title: 'Trashed', unavailable: true })
  })

  it('masks a second-locked entry when the locked view is not revealed', () => {
    expect(
      mentionDisplay({
        entry: makeEntry({ is_locked: true, title: 'Private' }),
        label: 'Old',
        lockedView: 'covered',
        activeVaultId: null,
      }),
    ).toEqual({ title: '', unavailable: true })
  })

  it('shows a second-locked entry once the locked view is revealed', () => {
    expect(
      mentionDisplay({
        entry: makeEntry({ is_locked: true, title: 'Private' }),
        label: 'Old',
        lockedView: 'revealed',
        activeVaultId: null,
      }),
    ).toEqual({ title: 'Private', unavailable: false })
  })

  it('masks a trashed entry that is also locked', () => {
    expect(
      mentionDisplay({
        entry: makeEntry({ title: 'Private', is_deleted: true, is_locked: true }),
        label: 'Old',
        lockedView: 'hidden',
        activeVaultId: null,
      }),
    ).toEqual({ title: '', unavailable: true })
  })

  it('propagates a live rename over the stored label', () => {
    expect(
      mentionDisplay({
        entry: makeEntry({ title: 'New' }),
        label: 'Old',
        lockedView: 'revealed',
        activeVaultId: null,
      }),
    ).toEqual({ title: 'New', unavailable: false })
  })

  it('falls back to the stored label for an untitled entry', () => {
    expect(
      mentionDisplay({
        entry: makeEntry({ title: null }),
        label: 'Old',
        lockedView: 'revealed',
        activeVaultId: null,
      }),
    ).toEqual({ title: 'Old', unavailable: false })
  })

  it('masks a vault entry while no vault is unlocked', () => {
    expect(
      mentionDisplay({
        entry: makeEntry({ is_invisible: true, vault_id: 'V' }),
        label: 'Old',
        lockedView: 'revealed',
        activeVaultId: null,
      }),
    ).toEqual({ title: '', unavailable: true })
  })

  it('shows a vault entry once its own vault is unlocked', () => {
    expect(
      mentionDisplay({
        entry: makeEntry({ is_invisible: true, vault_id: 'V' }),
        label: 'Old',
        lockedView: 'revealed',
        activeVaultId: 'V',
      }),
    ).toEqual({ title: 'Morning walk', unavailable: false })
  })

  it('masks a trashed entry that is also in a locked vault', () => {
    expect(
      mentionDisplay({
        entry: makeEntry({ title: 'Private', is_deleted: true, is_invisible: true, vault_id: 'V' }),
        label: 'Old',
        lockedView: 'revealed',
        activeVaultId: null,
      }),
    ).toEqual({ title: '', unavailable: true })
  })

  it('masks a vault entry belonging to a different vault than the active one', () => {
    expect(
      mentionDisplay({
        entry: makeEntry({ is_invisible: true, vault_id: 'V' }),
        label: 'Old',
        lockedView: 'revealed',
        activeVaultId: 'W',
      }),
    ).toEqual({ title: '', unavailable: true })
  })
})
