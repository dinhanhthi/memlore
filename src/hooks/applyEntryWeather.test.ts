import { describe, it, expect, vi, beforeEach } from 'vitest'
import { applyEntryWeather } from './applyEntryWeather'
import { fetchWeather, updateEntryWeather } from '../lib/tauri'
import type { Entry } from '../types/entry'

vi.mock('../lib/tauri', () => ({
  fetchWeather: vi.fn(),
  updateEntryWeather: vi.fn(),
}))

const mockEntry = (overrides: Partial<Entry> = {}): Entry => ({
  id: 'entry-1',
  journal_id: 'journal-1',
  title: null,
  preview_text: null,
  content_text: null,
  entry_date: 1_700_000_000,
  created_at: 1_700_000_000,
  updated_at: 1_700_000_000,
  latitude: 10,
  longitude: 20,
  location_label: 'Home',
  location_address: null,
  weather_summary: 'Clear sky, 25°C',
  weather_icon: '☀️',
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

describe('applyEntryWeather', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('fetches weather for the entry date and persists it', async () => {
    vi.mocked(fetchWeather).mockResolvedValue({
      summary: 'Rain, 12°C',
      icon: '🌧️',
      temperature: 12,
    })
    const updated = mockEntry({
      weather_summary: 'Rain, 12°C',
      weather_icon: '🌧️',
    })
    vi.mocked(updateEntryWeather).mockResolvedValue(updated)

    const result = await applyEntryWeather('entry-1', 10, 20, 1_700_000_000)

    expect(fetchWeather).toHaveBeenCalledWith(10, 20, 1_700_000_000)
    expect(updateEntryWeather).toHaveBeenCalledWith('entry-1', 'Rain, 12°C', '🌧️')
    expect(result).toEqual(updated)
  })

  it('returns null when fetch fails', async () => {
    vi.mocked(fetchWeather).mockRejectedValue(new Error('network'))

    const result = await applyEntryWeather('entry-1', 10, 20, 1_700_000_000)

    expect(result).toBeNull()
    expect(updateEntryWeather).not.toHaveBeenCalled()
  })

  it('returns null when update fails', async () => {
    vi.mocked(fetchWeather).mockResolvedValue({
      summary: 'Clear sky, 25°C',
      icon: '☀️',
      temperature: 25,
    })
    vi.mocked(updateEntryWeather).mockRejectedValue(new Error('db'))

    const result = await applyEntryWeather('entry-1', 10, 20, 1_700_000_000)

    expect(result).toBeNull()
  })
})
