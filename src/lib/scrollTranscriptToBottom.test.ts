import { describe, expect, it, vi } from 'vitest'
import {
  NEAR_BOTTOM_THRESHOLD_PX,
  resolveTranscriptScrollMode,
  scrollTranscriptToBottom,
  shouldScrollTranscriptToBottom,
} from './scrollTranscriptToBottom'

function fakeEl(partial: {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}): HTMLElement {
  return {
    ...partial,
    scrollTo: vi.fn(),
  } as unknown as HTMLElement
}

describe('resolveTranscriptScrollMode', () => {
  it('waits for history before consuming a pending force-scroll', () => {
    expect(
      resolveTranscriptScrollMode({
        pendingForce: true,
        pinToBottom: false,
        messageCount: 0,
      }),
    ).toEqual({
      mode: null,
      clearPending: false,
    })
  })

  it('force-scrolls and clears pending once messages are present', () => {
    expect(
      resolveTranscriptScrollMode({
        pendingForce: true,
        pinToBottom: false,
        messageCount: 3,
      }),
    ).toEqual({
      mode: 'force',
      clearPending: true,
    })
  })

  it('force-scrolls while the assistant reply is streaming', () => {
    expect(
      resolveTranscriptScrollMode({
        pendingForce: false,
        pinToBottom: true,
        messageCount: 3,
      }),
    ).toEqual({
      mode: 'force',
      clearPending: false,
    })
  })

  it('falls back to follow mode when neither force nor pin is active', () => {
    expect(
      resolveTranscriptScrollMode({
        pendingForce: false,
        pinToBottom: false,
        messageCount: 3,
      }),
    ).toEqual({
      mode: 'if-near-bottom',
      clearPending: false,
    })
  })
})

describe('shouldScrollTranscriptToBottom', () => {
  it('always returns true in force mode, even when scrolled far from bottom', () => {
    const el = {
      scrollHeight: 2000,
      scrollTop: 0,
      clientHeight: 400,
    }
    expect(shouldScrollTranscriptToBottom(el, 'force')).toBe(true)
  })

  it('returns true in follow mode only when within the near-bottom threshold', () => {
    const near = {
      scrollHeight: 1000,
      scrollTop: 1000 - 400 - (NEAR_BOTTOM_THRESHOLD_PX - 1),
      clientHeight: 400,
    }
    const far = {
      scrollHeight: 1000,
      scrollTop: 0,
      clientHeight: 400,
    }
    expect(shouldScrollTranscriptToBottom(near, 'if-near-bottom')).toBe(true)
    expect(shouldScrollTranscriptToBottom(far, 'if-near-bottom')).toBe(false)
  })
})

describe('scrollTranscriptToBottom', () => {
  it('force-scrolls to the end with smooth behavior when selecting a session', () => {
    const el = fakeEl({ scrollHeight: 2000, scrollTop: 0, clientHeight: 400 })
    const didScroll = scrollTranscriptToBottom(el, { mode: 'force', smooth: true })
    expect(didScroll).toBe(true)
    expect(el.scrollTo).toHaveBeenCalledWith({ top: 2000, behavior: 'smooth' })
  })

  it('force-scrolls instantly when smooth is disabled (reduced motion)', () => {
    const el = fakeEl({ scrollHeight: 2000, scrollTop: 0, clientHeight: 400 })
    scrollTranscriptToBottom(el, { mode: 'force', smooth: false })
    expect(el.scrollTo).toHaveBeenCalledWith({ top: 2000, behavior: 'auto' })
  })

  it('does not scroll in follow mode when the user has scrolled away', () => {
    const el = fakeEl({ scrollHeight: 2000, scrollTop: 0, clientHeight: 400 })
    const didScroll = scrollTranscriptToBottom(el, {
      mode: 'if-near-bottom',
      smooth: false,
    })
    expect(didScroll).toBe(false)
    expect(el.scrollTo).not.toHaveBeenCalled()
  })

  it('follow-mode scrolls instantly when near the bottom', () => {
    const el = fakeEl({
      scrollHeight: 1000,
      scrollTop: 1000 - 400 - 10,
      clientHeight: 400,
    })
    const didScroll = scrollTranscriptToBottom(el, {
      mode: 'if-near-bottom',
      smooth: false,
    })
    expect(didScroll).toBe(true)
    expect(el.scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'auto' })
  })
})
