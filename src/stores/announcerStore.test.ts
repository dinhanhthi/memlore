import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { announce, useAnnounce, useAnnouncerStore } from './announcerStore'

beforeEach(() => {
  useAnnouncerStore.setState({ message: '', nonce: 0 })
})

describe('announcerStore', () => {
  it('announce() stores the text for the live region', () => {
    announce('Generating…')

    expect(useAnnouncerStore.getState().message).toBe('Generating…')
  })

  it('announce() replaces the previous announcement', () => {
    announce('Generating…')
    announce('Done')

    expect(useAnnouncerStore.getState().message).toBe('Done')
  })

  it('announce() bumps nonce so the same text re-speaks', () => {
    announce('Done')
    const first = useAnnouncerStore.getState().nonce
    announce('Done')
    expect(useAnnouncerStore.getState().message).toBe('Done')
    expect(useAnnouncerStore.getState().nonce).toBe(first + 1)
  })

  it('useAnnounce() returns a function that writes the same store', () => {
    const { result } = renderHook(() => useAnnounce())

    act(() => {
      result.current('Summary ready')
    })

    expect(useAnnouncerStore.getState().message).toBe('Summary ready')
  })
})
