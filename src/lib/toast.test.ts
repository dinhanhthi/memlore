import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { toast, TOAST_CONTAINER_ID } from './toast'

describe('toast', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    document.getElementById(TOAST_CONTAINER_ID)?.remove()
  })

  it('appends a toast node to the document with the given message', () => {
    toast('Hello world')
    const container = document.getElementById(TOAST_CONTAINER_ID)
    expect(container).not.toBeNull()
    expect(container?.textContent).toContain('Hello world')
  })

  it('marks the toast with role="status" for assistive tech', () => {
    toast('Saved')
    const node = document.querySelector(`#${TOAST_CONTAINER_ID} [role="status"]`)
    expect(node).not.toBeNull()
  })

  it('auto-removes the toast after the given duration (+ fade-out grace)', () => {
    toast('Short-lived', { duration: 1000 })
    expect(document.getElementById(TOAST_CONTAINER_ID)?.childElementCount).toBe(1)

    // Within the visible duration, still present.
    vi.advanceTimersByTime(999)
    expect(document.getElementById(TOAST_CONTAINER_ID)?.childElementCount).toBe(1)

    // After duration + fade-out (200ms), removed.
    vi.advanceTimersByTime(1 + 250)
    expect(document.getElementById(TOAST_CONTAINER_ID)?.childElementCount ?? 0).toBe(0)
  })

  it('stacks multiple toasts in the same container', () => {
    toast('one')
    toast('two')
    const container = document.getElementById(TOAST_CONTAINER_ID)
    expect(container?.childElementCount).toBe(2)
  })

  it('reuses a single container across calls', () => {
    toast('a')
    const first = document.getElementById(TOAST_CONTAINER_ID)
    toast('b')
    const second = document.getElementById(TOAST_CONTAINER_ID)
    expect(first).toBe(second)
  })

  it('dedups back-to-back identical messages (key-repeat protection)', () => {
    toast('Coming soon')
    toast('Coming soon')
    toast('Coming soon')
    const container = document.getElementById(TOAST_CONTAINER_ID)
    expect(container?.childElementCount).toBe(1)
  })

  it('does NOT dedup when a different message arrives between duplicates', () => {
    toast('one')
    toast('two')
    toast('one')
    const container = document.getElementById(TOAST_CONTAINER_ID)
    expect(container?.childElementCount).toBe(3)
  })

  it('defaults duration to 2000ms when not provided', () => {
    toast('Default')
    vi.advanceTimersByTime(1999)
    expect(document.getElementById(TOAST_CONTAINER_ID)?.childElementCount).toBe(1)
    vi.advanceTimersByTime(1 + 250)
    expect(document.getElementById(TOAST_CONTAINER_ID)?.childElementCount ?? 0).toBe(0)
  })
})
