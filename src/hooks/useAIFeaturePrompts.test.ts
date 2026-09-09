import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useAIFeaturePrompts } from './useAIFeaturePrompts'

vi.mock('../lib/tauri', () => ({
  setAiFeaturePrompt: vi.fn(),
}))

import * as tauri from '../lib/tauri'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useAIFeaturePrompts', () => {
  it('savePrompt trims and invokes setAiFeaturePrompt', async () => {
    const { result } = renderHook(() => useAIFeaturePrompts())
    await act(async () => {
      await result.current.savePrompt('go_deeper', '  custom prompt  ')
    })
    expect(tauri.setAiFeaturePrompt).toHaveBeenCalledWith('go_deeper', 'custom prompt')
  })

  it('resetPrompt sends empty string', async () => {
    const { result } = renderHook(() => useAIFeaturePrompts())
    await act(async () => {
      await result.current.resetPrompt('title_suggestions')
    })
    expect(tauri.setAiFeaturePrompt).toHaveBeenCalledWith('title_suggestions', '')
  })
})
