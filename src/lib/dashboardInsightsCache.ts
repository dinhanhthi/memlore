import { getCachedThemeInsights } from './tauri'
import type { ThemeInsightsResult } from '../types/ai'

/** Cache-only read. Misses and IPC errors both become `null` — never throws, never generates. */
export async function loadCachedThemeInsights(
  start: number,
  end: number,
): Promise<ThemeInsightsResult | null> {
  try {
    return await getCachedThemeInsights(start, end)
  } catch {
    return null
  }
}
