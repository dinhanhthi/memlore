import { describe, it, expect, beforeEach } from 'vitest'
import { StrictMode } from 'react'
import { act, renderHook } from '@testing-library/react'

import { useChatAppendToApply, resolvePendingAppend } from './useChatAppendToApply'
import { useChatDraftStore } from '../stores/chatDraftStore'

beforeEach(() => {
  useChatDraftStore.setState({ pendingByEntryId: {}, pendingAppendByEntryId: {} })
})

describe('useChatAppendToApply', () => {
  it('returns null when there is no pending append', () => {
    const { result } = renderHook(() => useChatAppendToApply('entry-A'), { wrapper: StrictMode })
    expect(result.current).toBeNull()
  })

  it('drains a pending append and returns its html, consuming the store key', () => {
    act(() => {
      useChatDraftStore.getState().enqueuePendingChatAppend('entry-A', '<hr><p>x</p>')
    })
    const { result } = renderHook(() => useChatAppendToApply('entry-A'), { wrapper: StrictMode })
    expect(result.current?.html).toBe('<hr><p>x</p>')
    expect(useChatDraftStore.getState().pendingAppendByEntryId['entry-A']).toBeUndefined()
  })

  // The StrictMode double-mount race is what the hook exists to survive, but the
  // vitest env does not double-invoke StrictMode effects, so `renderHook` can't
  // reproduce it. We instead drive the extracted pure step through the exact two
  // passes a StrictMode remount produces.
  describe('resolvePendingAppend — StrictMode double-invoke (regression guard)', () => {
    it('restores the cached value on the second pass when the store key is already gone', () => {
      const append = { id: 'nonce-1', html: '<hr><p>keep me</p>' }
      const ref: { current: { id: string; html: string } | null } = { current: null }

      // Pass 1 (first mount): consume returns the value, cached in the ref.
      const pass1 = resolvePendingAppend(ref, append, () => append)
      expect(pass1).toEqual(append)
      expect(ref.current).toEqual(append)

      // Between passes, StrictMode's reset-effect cleanup nulls the React state
      // (simulated by not carrying `pass1` forward). Pass 2: the store key is
      // gone so consume() returns null — the ref must restore it.
      const pass2 = resolvePendingAppend(ref, append, () => null)
      expect(pass2).toEqual(append)
    })

    it('drops nothing only because of the ref — without it, pass 2 would be null', () => {
      // Proves the ref is load-bearing: a fresh ref (no cache) + a consume that
      // returns null (key already deleted) yields null — exactly the silent-drop
      // bug. The test above shows the cached ref prevents it.
      const freshRef: { current: { id: string; html: string } | null } = { current: null }
      expect(resolvePendingAppend(freshRef, { id: 'n', html: 'x' }, () => null)).toBeNull()
    })

    it('re-consumes when the nonce changes (new enqueue for the same entry)', () => {
      const ref: { current: { id: string; html: string } | null } = { current: null }
      const a = { id: 'n1', html: 'first' }
      const b = { id: 'n2', html: 'second' }
      expect(resolvePendingAppend(ref, a, () => a)).toEqual(a)
      // A new nonce mismatches the ref → consume runs again.
      expect(resolvePendingAppend(ref, b, () => b)).toEqual(b)
      expect(ref.current).toEqual(b)
    })

    it('returns null when there is no pending append', () => {
      const ref: { current: { id: string; html: string } | null } = { current: null }
      expect(resolvePendingAppend(ref, undefined, () => null)).toBeNull()
    })
  })

  it('resets on entry switch and does not re-apply when the same entry is reopened', () => {
    // Guards the E→F→E duplicate: <Editor/> remounts on entry switch and resets
    // its nonce guard, so a lingering append would be applied twice. The reset
    // must null the value when the entry changes, and the consumed store key
    // must NOT be re-applied when returning to the original entry.
    act(() => {
      useChatDraftStore.getState().enqueuePendingChatAppend('entry-E', '<hr><p>once</p>')
    })
    const { result, rerender } = renderHook(({ id }) => useChatAppendToApply(id), {
      wrapper: StrictMode,
      initialProps: { id: 'entry-E' },
    })
    expect(result.current?.html).toBe('<hr><p>once</p>')

    rerender({ id: 'entry-F' })
    expect(result.current).toBeNull()

    rerender({ id: 'entry-E' })
    expect(result.current).toBeNull()
  })

  it('re-applies when a new append is enqueued for the already-open entry', () => {
    const { result } = renderHook(() => useChatAppendToApply('entry-A'), { wrapper: StrictMode })
    expect(result.current).toBeNull()

    act(() => {
      useChatDraftStore.getState().enqueuePendingChatAppend('entry-A', '<hr><p>first</p>')
    })
    expect(result.current?.html).toBe('<hr><p>first</p>')

    // A fresh enqueue mints a new nonce → ref mismatch → re-consume and re-apply.
    act(() => {
      useChatDraftStore.getState().enqueuePendingChatAppend('entry-A', '<hr><p>second</p>')
    })
    expect(result.current?.html).toBe('<hr><p>second</p>')
  })
})
