import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

vi.mock('../lib/tauri', () => ({
  generateThemeInsights: vi.fn(),
  listEntriesForDateRange: vi.fn(),
}))

import * as tauri from '../lib/tauri'
import { useThemeInsights } from './useThemeInsights'

const START = 1_700_000_000
const END = START + 86_400 * 30

const SAMPLE = {
  start: START,
  end: END,
  entryCount: 2,
  themes: ['work'],
  moodDrivers: ['stress'],
  cached: false,
  modelId: 'mock:v1',
}

beforeEach(() => {
  vi.mocked(tauri.generateThemeInsights).mockReset()
  vi.mocked(tauri.listEntriesForDateRange).mockReset()
})

describe('useThemeInsights', () => {
  it('stays idle on mount and does not call generateThemeInsights', async () => {
    const { result } = renderHook(() =>
      useThemeInsights({
        start: START,
        end: END,
        needsBulkConsent: () => false,
        generationEndpointClass: 'local',
      }),
    )

    expect(result.current.phase.kind).toBe('idle')
    await Promise.resolve()
    expect(result.current.phase.kind).toBe('idle')
    expect(tauri.generateThemeInsights).not.toHaveBeenCalled()
  })

  it('generates immediately for local endpoints', async () => {
    vi.mocked(tauri.generateThemeInsights).mockResolvedValueOnce(SAMPLE)
    const { result } = renderHook(() =>
      useThemeInsights({
        start: START,
        end: END,
        needsBulkConsent: () => false,
        generationEndpointClass: 'local',
      }),
    )

    await act(async () => {
      await result.current.generate(false)
    })

    await waitFor(() => expect(result.current.phase.kind).toBe('ready'))
    expect(tauri.generateThemeInsights).toHaveBeenCalledWith(START, END, false)
  })

  it('pauses for bulk consent on remote when receipt missing', async () => {
    vi.mocked(tauri.listEntriesForDateRange).mockResolvedValueOnce([
      {
        id: 'e1',
        journal_id: 'j1',
        title: 'T',
        content_text: 'Body',
        entry_date: START,
        created_at: 0,
        updated_at: 0,
        preview_text: null,
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
        content_language: null,
        entry_date_user_edited: false,
        media_count: 0,
        from_chat: false,
      },
    ])

    const { result } = renderHook(() =>
      useThemeInsights({
        start: START,
        end: END,
        needsBulkConsent: () => true,
        generationEndpointClass: 'remote',
      }),
    )

    await act(async () => {
      await result.current.generate(false)
    })

    expect(result.current.phase.kind).toBe('needs_bulk_consent')
    expect(tauri.generateThemeInsights).not.toHaveBeenCalled()
  })
})
