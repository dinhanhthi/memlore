import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { invoke } from '@tauri-apps/api/core'
import { hydrateLanguage, useLanguage } from './useLanguage'
import { useUiStore } from '../stores/uiStore'
import { i18n } from '../lib/i18n'

const mockedInvoke = vi.mocked(invoke)

beforeEach(async () => {
  mockedInvoke.mockReset()
  useUiStore.setState({ uiLanguage: 'en' })
  await i18n.changeLanguage('en')
})

describe('useLanguage', () => {
  it('never calls Tauri invoke — the DB path is gone', async () => {
    useUiStore.setState({ uiLanguage: 'vi' })

    await hydrateLanguage()

    const { result } = renderHook(() => useLanguage())
    await act(async () => {
      await result.current.setLanguage('en')
    })

    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it("hydrateLanguage() applies the store's current uiLanguage to i18next", async () => {
    useUiStore.setState({ uiLanguage: 'vi' })

    await hydrateLanguage()

    expect(i18n.language).toBe('vi')
  })

  it('setLanguage(vi) updates the store and switches i18next', async () => {
    const { result } = renderHook(() => useLanguage())
    await waitFor(() => {
      expect(result.current.uiLanguage).toBe('en')
    })

    await act(async () => {
      await result.current.setLanguage('vi')
    })

    expect(useUiStore.getState().uiLanguage).toBe('vi')
    expect(i18n.language).toBe('vi')
  })

  it('rejects unknown language codes without touching the store or i18next', async () => {
    const { result } = renderHook(() => useLanguage())
    await waitFor(() => expect(result.current.uiLanguage).toBe('en'))

    await act(async () => {
      await expect(
        // @ts-expect-error deliberate invalid input
        result.current.setLanguage('de'),
      ).rejects.toThrow()
    })

    expect(useUiStore.getState().uiLanguage).toBe('en')
    expect(i18n.language).toBe('en')
    expect(mockedInvoke).not.toHaveBeenCalled()
  })
})
