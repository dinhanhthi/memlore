import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { invoke } from '@tauri-apps/api/core'
import {
  __resetEditorTypographyForTests,
  hydrateEditorTypography,
  useEditorTypography,
  useEditorTypographyHydrated,
  useEditorTypographySetting,
  isEditorTypographyHydrated,
} from './useEditorTypography'

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  mockedInvoke.mockReset()
  mockedInvoke.mockImplementation(async () => null)
  __resetEditorTypographyForTests()
})

describe('useEditorTypography', () => {
  it('hydrates defaults when settings are absent', async () => {
    await hydrateEditorTypography()
    const { result } = renderHook(() => useEditorTypography())
    const { result: hydrated } = renderHook(() => useEditorTypographyHydrated())
    expect(result.current).toEqual({
      lineHeight: 'normal',
      paragraphSpacing: 'normal',
      firstLineIndent: false,
      hyphenation: false,
    })
    expect(hydrated.current).toBe(true)
    expect(isEditorTypographyHydrated()).toBe(true)
  })

  it('hydrates stored values', async () => {
    mockedInvoke.mockImplementation(async (cmd, args) => {
      if (cmd !== 'get_setting') return null
      const key = (args as { key: string }).key
      if (key === 'editor_line_height') return 'relaxed'
      if (key === 'editor_paragraph_spacing') return 'compact'
      if (key === 'editor_first_line_indent') return 'true'
      if (key === 'editor_hyphenation') return 'true'
      return null
    })
    await hydrateEditorTypography()
    const { result } = renderHook(() => useEditorTypography())
    expect(result.current).toEqual({
      lineHeight: 'relaxed',
      paragraphSpacing: 'compact',
      firstLineIndent: true,
      hyphenation: true,
    })
  })

  it('setters persist and update live values', async () => {
    await hydrateEditorTypography()
    const { result } = renderHook(() => useEditorTypographySetting())

    await act(async () => {
      await result.current.setLineHeight('relaxed')
      await result.current.setParagraphSpacing('compact')
      await result.current.setFirstLineIndent(true)
      await result.current.setHyphenation(true)
    })

    await waitFor(() => {
      expect(result.current.lineHeight).toBe('relaxed')
      expect(result.current.paragraphSpacing).toBe('compact')
      expect(result.current.firstLineIndent).toBe(true)
      expect(result.current.hyphenation).toBe(true)
    })

    const setCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'set_setting')
    expect(setCalls).toEqual(
      expect.arrayContaining([
        ['set_setting', { key: 'editor_line_height', value: 'relaxed' }],
        ['set_setting', { key: 'editor_paragraph_spacing', value: 'compact' }],
        ['set_setting', { key: 'editor_first_line_indent', value: 'true' }],
        ['set_setting', { key: 'editor_hyphenation', value: 'true' }],
      ]),
    )
  })
})
