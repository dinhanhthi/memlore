import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useEditorProseVoice } from './useEditorProseVoice'

vi.mock('../lib/tauri', () => ({
  rewriteSelection: vi.fn(),
  continueWriting: vi.fn(),
}))

import * as tauri from '../lib/tauri'

beforeEach(() => vi.clearAllMocks())

describe('useEditorProseVoice', () => {
  it('forwards the live selection and returns only provider prose', async () => {
    vi.mocked(tauri.rewriteSelection).mockResolvedValueOnce('Rewritten')
    const { result } = renderHook(() => useEditorProseVoice())
    let prose = ''
    await act(async () => {
      prose = await result.current.rewrite('e1', 'unsaved selection')
    })
    expect(prose).toBe('Rewritten')
    expect(tauri.rewriteSelection).toHaveBeenCalledWith('e1', 'unsaved selection')
  })

  it('exposes a stable error code when continue fails', async () => {
    vi.mocked(tauri.continueWriting).mockRejectedValueOnce('AI_PRIVACY_NOT_ACCEPTED: detail')
    const { result } = renderHook(() => useEditorProseVoice())
    await act(async () => {
      await expect(result.current.continueWriting('e1', 'context')).rejects.toBe(
        'AI_PRIVACY_NOT_ACCEPTED: detail',
      )
    })
    await waitFor(() => expect(result.current.errorCode).toBe('AI_PRIVACY_NOT_ACCEPTED'))
  })
})
