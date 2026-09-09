import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ThemeInsightsResult } from '../types/ai'

vi.mock('./tauri', () => ({
  getCachedThemeInsights: vi.fn(),
  generateThemeInsights: vi.fn(),
}))

import * as tauri from './tauri'
import { loadCachedThemeInsights } from './dashboardInsightsCache'

const SAMPLE: ThemeInsightsResult = {
  start: 1_700_000_000,
  end: 1_700_000_000 + 86_400 * 30,
  entryCount: 2,
  themes: ['work'],
  moodDrivers: ['stress'],
  cached: true,
  modelId: 'mock:v1',
}

beforeEach(() => {
  vi.mocked(tauri.getCachedThemeInsights).mockReset()
  vi.mocked(tauri.generateThemeInsights).mockReset()
})

describe('loadCachedThemeInsights', () => {
  it('returns the cached row when the read hits', async () => {
    vi.mocked(tauri.getCachedThemeInsights).mockResolvedValueOnce(SAMPLE)
    await expect(loadCachedThemeInsights(SAMPLE.start, SAMPLE.end)).resolves.toEqual(SAMPLE)
    expect(tauri.getCachedThemeInsights).toHaveBeenCalledWith(SAMPLE.start, SAMPLE.end)
  })

  it('returns null on a cache miss', async () => {
    vi.mocked(tauri.getCachedThemeInsights).mockResolvedValueOnce(null)
    await expect(loadCachedThemeInsights(SAMPLE.start, SAMPLE.end)).resolves.toBeNull()
  })

  it('returns null when the read rejects, never throwing', async () => {
    vi.mocked(tauri.getCachedThemeInsights).mockRejectedValueOnce(new Error('boom'))
    await expect(loadCachedThemeInsights(SAMPLE.start, SAMPLE.end)).resolves.toBeNull()
  })

  it('never calls generateThemeInsights', async () => {
    vi.mocked(tauri.getCachedThemeInsights).mockResolvedValueOnce(null)
    await loadCachedThemeInsights(SAMPLE.start, SAMPLE.end)
    expect(tauri.generateThemeInsights).not.toHaveBeenCalled()
  })
})
