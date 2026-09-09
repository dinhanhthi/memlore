import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { hydrateLanguage } from './useLanguage'
import { useLanguageHydration } from './useLanguageHydration'

vi.mock('./useLanguage', () => ({
  hydrateLanguage: vi.fn().mockResolvedValue(undefined),
}))

beforeEach(() => {
  vi.mocked(hydrateLanguage).mockClear()
})

describe('useLanguageHydration', () => {
  it('hydrates language on mount without a dbReady argument', () => {
    renderHook(() => useLanguageHydration())
    expect(hydrateLanguage).toHaveBeenCalledOnce()
  })

  it('hydration effect deps exclude dbReady', () => {
    const src = readFileSync(resolve(__dirname, './useLanguageHydration.ts'), 'utf8')
    expect(src).not.toMatch(/\bdbReady\b/)
    expect(src).toMatch(/void hydrateLanguage\(\)\s*\n\s*\}, \[\]\)/)
  })
})
