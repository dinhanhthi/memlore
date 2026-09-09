import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useUiFontScale } from './useUiFontScale'
import { useUiStore } from '../stores/uiStore'

beforeEach(() => {
  useUiStore.setState({ uiFontScale: 1 })
  document.documentElement.style.removeProperty('--ui-font-scale')
})

afterEach(() => {
  document.documentElement.style.removeProperty('--ui-font-scale')
})

describe('useUiFontScale', () => {
  it('sets --ui-font-scale to the store value on mount', () => {
    useUiStore.setState({ uiFontScale: 1.1 })
    renderHook(() => useUiFontScale())
    expect(document.documentElement.style.getPropertyValue('--ui-font-scale')).toBe('1.1')
  })

  it('updates --ui-font-scale when the store value changes', () => {
    renderHook(() => useUiFontScale())
    expect(document.documentElement.style.getPropertyValue('--ui-font-scale')).toBe('1')

    act(() => {
      useUiStore.getState().setUiFontScale(1.1)
    })

    expect(document.documentElement.style.getPropertyValue('--ui-font-scale')).toBe('1.1')
  })

  it('removes the inline override on unmount so :root default (1) applies', () => {
    useUiStore.setState({ uiFontScale: 1.1 })
    const { unmount } = renderHook(() => useUiFontScale())
    expect(document.documentElement.style.getPropertyValue('--ui-font-scale')).toBe('1.1')

    unmount()

    expect(document.documentElement.style.getPropertyValue('--ui-font-scale')).toBe('')
  })
})
